// One run of one workflow, and the login window for an account: opens that account's browser, confirms the session, hands the page to the steps, and records what happened. It does not reach into what a step does.

const path = require("path");
const browser = require("./adapters/browser.adapter.cjs");
const { createLinkedIn } = require("./adapters/linkedin.adapter.cjs");
const { validate } = require("./domain/graph.cjs");
const { run: runGraph } = require("./domain/engine.cjs");
const { catalog } = require("./nodes.cjs");
const { sendDueFollowUps } = require("./nodes.crm.cjs");
const { pollNewItems } = require("./scheduler.cjs");
const { LINKEDIN, SELECTORS, TIMEOUT } = require("./constants.cjs");

// The scheduler retries a busy account later instead of recording a failure, so it needs to tell this case apart.
const busyError = (message) => Object.assign(new Error(message), { code: "BUSY" });

// The real way to reach LinkedIn: a Camoufox profile per account. The end-to-end tests pass a scripted fake with the same three functions instead.
const camoufoxLinkedIn = {
  isOpen: (profileDir) => browser.isOpen(profileDir),
  async open(profileDir, { headless, log, shouldStop }) {
    const session = await browser.launch(profileDir, { headless });
    return { linkedin: createLinkedIn(session.page, { log, shouldStop }), close: session.close };
  },
  // A visible window the person logs in through themselves, including two-factor; the app never sees the password.
  async login(profileDir) {
    const session = await browser.launch(profileDir, { headless: false });
    try {
      await session.page.goto(LINKEDIN.LOGIN, { waitUntil: "domcontentloaded" }).catch(() => {});
      const deadline = Date.now() + TIMEOUT.MANUAL_LOGIN;
      while (Date.now() < deadline) {
        if (session.page.isClosed()) throw new Error("The login window was closed before login finished");
        const home = await session.page.$(SELECTORS.NAV_HOME).catch(() => null);
        if (home || /\/feed/.test(session.page.url())) return { profileUrl: await createLinkedIn(session.page).ensureLoggedIn().catch(() => null) };
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("Login was not finished within 5 minutes");
    } finally {
      await session.close();
    }
  },
};

function createRunner({ store, llm, dataDir, send, fetchJson, linkedinAccess = camoufoxLinkedIn }) {
  const profileDir = (accountId) => path.join(dataDir, "accounts", accountId, "browser");
  const active = new Map();

  // One browser per profile: a second one on the same profile would fight the first over the session.
  const assertFree = (accountId) => {
    if ([...active.values()].some((r) => r.accountId === accountId) || linkedinAccess.isOpen(profileDir(accountId))) throw busyError("This account is already busy with another run or a login window");
  };

  // firedBy and items come from the scheduler; a press of Run passes neither, and every trigger fires. firedBy "followUp" with followups (due rows) sends follow-ups instead of running the graph, on the rows' account, which may differ from the workflow's current one.
  async function start(workflowId, { firedBy = null, items = null, followups = null } = {}) {
    const isFollowUp = firedBy === "followUp";
    const stored = store.workflows.get(workflowId);
    if (!stored && !isFollowUp) throw new Error("Workflow not found");
    const wf = stored || { id: workflowId, name: null, nodes: [], edges: [] };
    const accountId = isFollowUp ? followups?.[0]?.accountId : wf.accountId;
    if (!accountId || !store.accounts.get(accountId)) throw new Error(isFollowUp ? "The follow-ups' LinkedIn account no longer exists" : "Pick a LinkedIn account for this workflow first");
    // A follow-up run does not execute the graph, so a workflow edited into an invalid state must not hold back messages already promised.
    if (!isFollowUp) {
      const problems = validate(wf, catalog);
      if (problems.length) throw new Error(problems.map((p) => p.message).join("; "));
    }
    assertFree(accountId);

    const firedNode = firedBy && wf.nodes.find((n) => n.id === firedBy);
    const runId = store.runs.start(wf.id, accountId, isFollowUp ? "followUp" : firedNode ? firedNode.type : "manual", { nodes: wf.nodes, edges: wf.edges });
    const state = { accountId, stop: false };
    active.set(runId, state);
    const emit = (e) => { const event = { at: Date.now(), ...e }; store.runs.event(runId, event); send("run:event", { runId, workflowId: wf.id, ...event }); };
    // The run continues after this call returns; the renderer follows it through run:event and run:finished.
    execute(wf, runId, state, emit, { firedBy, items, followups });
    return runId;
  }

  async function execute(wf, runId, state, emit, trigger) {
    let session;
    let result = { status: "failed", error: "did not start", outputs: {} };
    const shouldStop = () => state.stop;
    try {
      emit({ type: "log", message: "Opening the browser" });
      session = await linkedinAccess.open(profileDir(state.accountId), { headless: !!store.settings.get("browser.headless"), log: (message) => emit({ type: "log", message }), shouldStop });
      const { linkedin } = session;
      await linkedin.ensureLoggedIn();
      if (trigger.firedBy === "followUp") {
        emit({ type: "log", message: `Logged in; ${trigger.followups.length} follow-ups due` });
        const outputs = await sendDueFollowUps(trigger.followups, { linkedin, store, accountId: state.accountId, runId, workflowId: wf.id, emit, shouldStop });
        result = { status: shouldStop() ? "stopped" : "finished", outputs };
        return;
      }
      emit({ type: "log", message: "Logged in; starting the workflow" });
      // A manual run of a Poll API step fetches now and marks what it took as seen, the same way a scheduled poll does.
      const pollNow = async (nodeId) => {
        const r = await pollNewItems({ store, workflowId: wf.id, node: wf.nodes.find((n) => n.id === nodeId), fetchJson });
        store.triggers.markSeen(wf.id, nodeId, r.keys);
        return r;
      };
      result = await runGraph(wf, { catalog, ctx: { linkedin, llm, store, accountId: wf.accountId, workflowId: wf.id, runId, trigger, pollNow }, emit, shouldStop, firedBy: trigger.firedBy });
    } catch (err) {
      result = { status: "failed", error: err.message, outputs: result.outputs || {} };
      emit({ type: "log", message: `Run failed: ${err.message}` });
    } finally {
      await session?.close();
      store.runs.saveOutputs(runId, result.outputs || {});
      // The CRM is a convenience on top of the run record; a problem filing contacts must not lose the run's own result.
      try {
        const filed = store.crm.absorbRun({ runId, workflowId: wf.id, accountId: state.accountId, outputs: result.outputs || {} });
        if (filed.people || filed.posts) emit({ type: "log", message: `CRM updated: ${filed.people} people, ${filed.posts} posts` });
      } catch (err) {
        emit({ type: "log", message: `Could not update the CRM: ${err.message}` });
      }
      store.runs.finish(runId, result.status, result.error);
      active.delete(runId);
      send("run:finished", { runId, workflowId: wf.id, status: result.status, error: result.error || null });
    }
  }

  function stop(runId) {
    const state = active.get(runId);
    if (state) state.stop = true;
    return !!state;
  }

  async function login(accountId) {
    if ([...active.values()].some((r) => r.accountId === accountId)) throw busyError("This account is in the middle of a run");
    const { profileUrl } = await linkedinAccess.login(profileDir(accountId));
    store.accounts.markLoggedIn(accountId, profileUrl);
    return { loggedIn: true, profileUrl };
  }

  return { start, stop, login, isRunning: (runId) => active.has(runId), hasActiveRuns: () => active.size > 0, profileDir };
}

module.exports = { createRunner };
