// The Electron main process: opens the window, the database and the runner, and answers the editor's IPC calls.

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, safeStorage, shell, powerSaveBlocker } = require("electron");
const { openStore } = require("./adapters/store.adapter.cjs");
const { createLlm } = require("./adapters/llm.adapter.cjs");
const browser = require("./adapters/browser.adapter.cjs");
const { fetchJson } = require("./adapters/api.adapter.cjs");
const { createRunner } = require("./runner.cjs");
const { createScheduler } = require("./scheduler.cjs");
const { catalog, describeCatalog } = require("./nodes.cjs");
const { validate } = require("./domain/graph.cjs");
const { templates } = require("./templates.cjs");
const { LLM_DEFAULTS } = require("./constants.cjs");

// Lets a smoke test or a second copy run against its own database and browser profiles.
if (process.env.OUTREACH_USER_DATA) app.setPath("userData", process.env.OUTREACH_USER_DATA);
// End-to-end tests relaunch on the same data with the clock moved forward, so a schedule or a follow-up booked days out comes due without waiting.
if (process.env.OUTREACH_CLOCK_OFFSET_MS) { const realNow = Date.now; Date.now = () => realNow() + Number(process.env.OUTREACH_CLOCK_OFFSET_MS); }

// Each starter workflow is added once per install, keyed so a later release can add new ones; a workflow the owner deleted stays deleted, and one already present under the same name (from before keys existed) is not duplicated.
function seedBuiltIns(store) {
  const seeded = new Set(store.settings.get("seeded.templates") || []);
  const names = new Set(store.workflows.list().map((w) => w.name));
  const firstAccount = store.accounts.list()[0]?.id || null;
  for (const t of templates) {
    if (seeded.has(t.key)) continue;
    if (!store.workflows.hasTemplate(t.key) && !names.has(t.name)) store.workflows.save({ ...t, templateKey: t.key, accountId: firstAccount });
    seeded.add(t.key);
  }
  store.settings.set("seeded.templates", [...seeded]);
}

let win;
const send = (channel, data) => win && !win.isDestroyed() && win.webContents.send(channel, data);

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { data: await fn(...args) }; } catch (err) { return { error: err.message }; }
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  const store = openStore(path.join(dataDir, "outreach.db"));
  store.runs.closeInterrupted();
  seedBuiltIns(store);

  // The API key is encrypted with the OS keychain's key before it touches the database.
  const apiKey = () => {
    const enc = store.settings.get("llm.apiKeyEnc");
    return enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, "base64")) : "";
  };
  let llm = createLlm(() => ({ baseUrl: store.settings.get("llm.baseUrl") || LLM_DEFAULTS.baseUrl, model: store.settings.get("llm.model") || LLM_DEFAULTS.model, apiKey: apiKey() }));
  let linkedinAccess;
  // End-to-end tests run the whole app against a scripted LinkedIn and model; nothing touches the network or a real account.
  if (process.env.OUTREACH_FAKE) ({ linkedinAccess, llm } = require("./adapters/fake.adapter.cjs").createFakes({ scenario: process.env.OUTREACH_FAKE }));
  const runner = createRunner({ store, llm, dataDir, send, fetchJson, linkedinAccess });
  // new Date() ignores the end-to-end clock shift above, so the scheduler reads the time through Date.now.
  const scheduler = createScheduler({ store, runner, fetchJson, now: () => new Date(Date.now()), onChange: (workflowId) => send("triggers:changed", { workflowId }) });
  scheduler.start();

  // macOS suspends a hidden app's timers (App Nap), which would silently stop schedules; hold a blocker only while something is Active.
  let blocker = null;
  // Pending follow-ups need the app running just as Active workflows do, or a closed window would silently stop them.
  const hasBackgroundWork = () => store.workflows.listActive().length > 0 || store.followups.list({ status: "active" }).length > 0;
  const syncBackground = () => {
    const anyActive = hasBackgroundWork();
    if (anyActive && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!anyActive && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  };
  syncBackground();
  setInterval(syncBackground, 60_000);

  handle("catalog:list", () => describeCatalog());

  handle("accounts:list", () => store.accounts.list().map((a) => ({ ...a, profileDir: runner.profileDir(a.id) })));
  handle("accounts:create", (name) => store.accounts.create(String(name || "").trim() || "LinkedIn account"));
  handle("accounts:remove", async (id) => {
    await browser.closeProfile(runner.profileDir(id));
    store.accounts.remove(id);
    fs.rmSync(path.dirname(runner.profileDir(id)), { recursive: true, force: true });
  });
  handle("accounts:login", (id) => runner.login(id));
  handle("accounts:actions", (id) => store.actions.recent(id));
  handle("accounts:rename", (id, name) => store.accounts.rename(id, name));

  handle("crm:contacts:list", (filter) => store.crm.contacts.list(filter || {}));
  handle("crm:contacts:get", (id) => store.crm.contacts.get(id));
  handle("crm:contacts:update", (id, patch) => store.crm.contacts.update(id, patch || {}));
  handle("crm:contacts:setOutreachState", (id, action) => store.crm.contacts.setOutreachState(id, action));
  handle("crm:outreachStates", () => store.crm.outreachStates());
  handle("crm:tags", () => store.crm.tags());
  handle("crm:stages", () => store.crm.stages());
  handle("crm:posts:list", (filter) => store.crm.posts.list(filter || {}));
  handle("crm:posts:get", (id) => store.crm.posts.get(id));

  handle("followups:list", (filter) => store.followups.list(filter || {}));
  handle("followups:cancel", (id) => store.followups.cancel(id));
  handle("followups:runNow", (accountId) => scheduler.tickFollowUps({ accountId, force: true }));

  handle("workflows:list", () => store.workflows.list());
  handle("workflows:get", (id) => store.workflows.get(id));
  handle("workflows:save", (wf) => { const saved = store.workflows.save(wf); store.triggers.reset(saved.id); return saved; });
  handle("workflows:remove", (id) => { store.workflows.remove(id); syncBackground(); });
  handle("workflows:setActive", (id, active) => {
    const wf = store.workflows.get(id);
    if (active) {
      if (!wf.nodes.some((n) => n.type === "schedule" || n.type === "pollApi")) throw new Error("Add a Schedule or Poll API trigger first; Active only matters for those");
      if (!wf.accountId) throw new Error("Pick a LinkedIn account first");
      const problems = validate(wf, catalog);
      if (problems.length) throw new Error(problems.map((p) => p.message).join("; "));
    }
    store.workflows.setActive(id, active);
    store.triggers.reset(id);
    syncBackground();
    scheduler.tick().catch(() => {});
  });
  handle("workflows:triggers", (id) => store.triggers.forWorkflow(id));
  handle("workflows:validate", (wf) => validate(wf, catalog));

  handle("runs:start", (workflowId) => runner.start(workflowId));
  handle("runs:stop", (runId) => runner.stop(runId));
  handle("runs:list", (workflowId) => store.runs.list(workflowId));
  handle("runs:get", (runId) => store.runs.get(runId));
  handle("runs:history", (filter) => store.runs.history(filter));
  handle("runs:remove", (runId) => store.runs.remove(runId));

  handle("settings:get", () => ({
    baseUrl: store.settings.get("llm.baseUrl") || LLM_DEFAULTS.baseUrl,
    model: store.settings.get("llm.model") || LLM_DEFAULTS.model,
    hasApiKey: !!apiKey(),
    headless: !!store.settings.get("browser.headless"),
    calendarLink: store.settings.get("outreach.calendarLink") || "",
  }));
  handle("settings:set", (s) => {
    if (s.baseUrl !== undefined) store.settings.set("llm.baseUrl", s.baseUrl.trim());
    if (s.model !== undefined) store.settings.set("llm.model", s.model.trim());
    if (s.headless !== undefined) store.settings.set("browser.headless", !!s.headless);
    if (s.calendarLink !== undefined) {
      const link = String(s.calendarLink).trim();
      if (link && !/^https?:\/\//i.test(link)) throw new Error("The calendar link must start with https://");
      store.settings.set("outreach.calendarLink", link);
    }
    if (s.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain is not available, so the key cannot be stored safely");
      store.settings.set("llm.apiKeyEnc", safeStorage.encryptString(s.apiKey.trim()).toString("base64"));
    }
  });

  win = new BrowserWindow({
    width: 1440, height: 900, title: "HireDue Outreach", show: !process.env.OUTREACH_E2E_BLANK,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  // Profile and post links in the output table open in the person's own browser, not a second app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // End-to-end tests drive the app through window.outreach only, so they load an empty page that still gets the preload and never wait on a UI build.
  if (process.env.OUTREACH_E2E_BLANK) win.loadURL("about:blank");
  else if (app.isPackaged || process.env.OUTREACH_DIST) win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  else win.loadURL("http://localhost:5173");

  // With Active workflows, closing the window hides it so schedules keep firing; the dock icon brings it back and Cmd+Q quits.
  let quitting = false;
  win.on("close", (e) => {
    if (!quitting && process.platform === "darwin" && hasBackgroundWork()) { e.preventDefault(); win.hide(); }
  });
  app.on("activate", () => win.show());
  app.on("before-quit", () => { quitting = true; scheduler.stop(); browser.closeAll(); store.close(); });
});

app.on("window-all-closed", () => app.quit());
