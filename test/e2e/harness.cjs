// Starts the real app (main process, IPC, runner, scheduler, SQLite) against the scripted LinkedIn and model in electron/adapters/fake.adapter.cjs, and gives tests short ways to drive it through window.outreach and read back what it did.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const { _electron } = require(path.join(ROOT, "node_modules", "playwright"));
// Under plain Node, require("electron") is the path to the Electron binary.
const ELECTRON = require(path.join(ROOT, "node_modules", "electron"));

const profile = (slug) => `https://www.linkedin.com/in/${slug}/`;
const postUrn = (n) => `urn:li:activity:700000000000000000${n}`;
const postLink = (n) => `https://www.linkedin.com/feed/update/${postUrn(n)}/`;

// A chain of steps joined head to tail; a step's `from` names a different source handle (pass, fail, true...) for the edge into it.
function chain(name, accountId, steps) {
  const nodes = steps.map((s, i) => ({ id: s.id || `${s.type}${i}`, type: s.type, position: { x: i * 300, y: 80 }, params: s.params || {} }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, sourceHandle: steps[i + 1].from || "out", target: n.id }));
  return { name, accountId, nodes, edges };
}

// Data folders are removed when the test file's process exits, not on close, because the schedule and follow-up tests relaunch on the same folder.
const created = [];
process.on("exit", () => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

// ui: true loads the built renderer from dist (run `npx vite build` first) so a test can click through the real screens; otherwise the page is blank and tests use window.outreach only.
async function launch({ scenario = "default", userData = null, env = {}, ui = false } = {}) {
  if (ui && !fs.existsSync(path.join(ROOT, "dist", "index.html"))) throw new Error("UI tests load dist/index.html; run `npx vite build` first");
  const dir = userData || fs.mkdtempSync(path.join(os.tmpdir(), "outreach-e2e-"));
  if (!userData) created.push(dir);
  const logFile = path.join(dir, "fake-linkedin.jsonl");
  const childEnv = { ...process.env, OUTREACH_FAKE: scenario, OUTREACH_FAKE_LOG: logFile, OUTREACH_USER_DATA: dir, ...(ui ? { OUTREACH_DIST: "1" } : { OUTREACH_E2E_BLANK: "1" }), OUTREACH_TICK_MS: "200", ...env };
  if (ui) delete childEnv.OUTREACH_E2E_BLANK;
  // VS Code and some shells export this, which makes Electron start as plain Node with no app object.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronApp = await _electron.launch({ executablePath: ELECTRON, args: [ROOT], env: childEnv, timeout: 30_000 });
  const win = await electronApp.firstWindow();
  await win.waitForFunction(() => !!window.outreach, null, { timeout: 15_000 });
  if (ui) await win.getByTestId("nav-dashboard").waitFor({ timeout: 15_000 });

  // Calls window.outreach.<dotted path>(...args) in the page, so every call crosses the real preload and IPC.
  const call = (fnPath, ...args) => win.evaluate(([p, a]) => p.split(".").reduce((o, k) => o[k], window.outreach)(...a), [fnPath, args]);

  const app = {
    dir, logFile, electronApp, win, call,
    has: (fnPath) => win.evaluate((p) => typeof p.split(".").reduce((o, k) => o?.[k], window.outreach) === "function", fnPath),
    createAccount: (name = "Test account") => call("accounts.create", name),
    save: (wf) => call("workflows.save", wf),
    start: (workflowId) => call("runs.start", workflowId),
    getRun: (runId) => call("runs.get", runId),
    history: (filter = {}) => call("runs.history", filter),
    async waitForRun(runId, { timeout = 20_000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const run = await call("runs.get", runId);
        if (run && run.status !== "running") return run;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`run ${runId} still running after ${timeout}ms`);
    },
    async run(wf, opts) {
      const saved = await call("workflows.save", wf);
      const runId = await call("runs.start", saved.id);
      return app.waitForRun(runId, opts);
    },
    // Every outward action the fake LinkedIn saw, optionally narrowed by account, action and run window.
    actions({ accountId = null, action = null, since = 0 } = {}) {
      if (!fs.existsSync(logFile)) return [];
      return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((e) => (!accountId || e.accountId === accountId) && (!action || e.action === action) && e.at >= since);
    },
    async waitFor(fn, { timeout = 15_000, what = "condition" } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    close: () => electronApp.close().catch(() => {}),
  };
  return app;
}

// Each step's row as run history shows it, keyed by node id: { state, input, counts, failedItems, error }.
const steps = (run) => Object.fromEntries(run.summary.steps.map((s) => [s.nodeId, s]));

module.exports = { launch, chain, steps, profile, postUrn, postLink };
