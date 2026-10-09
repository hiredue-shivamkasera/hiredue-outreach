// The app driven through its real screens: the built renderer from dist, clicked like a person would, against the scripted LinkedIn and model.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, chain, profile } = require("./harness.cjs");

const CANVAS = "[data-testid=editor-canvas]";
const node = (id) => `${CANVAS} .react-flow__node[data-id${id.endsWith("-") ? "^" : ""}="${id}"]`;

// textContent, not innerText, so CSS capitalisation does not change what a status reads.
const text = (loc) => loc.textContent().then((s) => s.trim());
const sidebarWorkflow = (win, name) => win.locator("[data-sidebar=menu-sub-button]", { hasText: name });
const main = (win) => win.locator("#main-scroll");

async function waitUntil(fn, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function addAccount(win, name) {
  await win.getByTestId("nav-accounts").click();
  await win.getByPlaceholder("Account name, e.g. Shivam").fill(name);
  await win.getByRole("button", { name: "Add account" }).click();
  await main(win).getByText(name, { exact: true }).waitFor();
}

async function openWorkflow(win, name) {
  await sidebarWorkflow(win, name).click();
  await main(win).getByRole("heading", { name, exact: true }).waitFor();
}

async function chooseOption(win, trigger, option) {
  await trigger.click();
  await win.getByRole("option", { name: option, exact: true }).click();
}

// Picks the account in the workflow page header, presses Run, and waits for the newest run in the runs list to leave "running".
async function runFromPage(win, account) {
  if (account) await chooseOption(win, main(win).locator("[data-slot=select-trigger]").first(), account);
  const before = await main(win).getByTestId("run-row").count();
  await win.getByTestId("workflow-run").click();
  await waitUntil(async () => (await main(win).getByTestId("run-row").count()) > before, "the new run in the runs list");
  const status = main(win).getByTestId("run-row").first().getByTestId("run-status");
  await waitUntil(async () => (await text(status)) !== "running", "the run to finish");
  return text(status);
}

async function dragHandle(win, from, to) {
  const a = await win.locator(`${from} .react-flow__handle.source`).boundingBox();
  const b = await win.locator(`${to} .react-flow__handle.target`).boundingBox();
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await win.mouse.up();
}

describe("UI", () => {
  let app;
  let win;
  const errors = [];
  before(async () => {
    app = await launch({ ui: true });
    win = app.win;
    win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    win.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  });
  after(() => app?.close());

  test("Every sidebar section opens without errors", async () => {
    const sections = { "nav-workflows": "Workflows", "nav-crm-people": "People", "nav-crm-posts": "Posts", "nav-runs": "Run history", "nav-accounts": "LinkedIn accounts", "nav-settings": "Settings", "nav-dashboard": "Dashboard" };
    for (const [id, heading] of Object.entries(sections)) {
      await win.getByTestId(id).click();
      await main(win).getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
    }
    await openWorkflow(win, "AI fit check");
    await win.getByTestId("workflow-edit").click();
    await win.locator(node("ai")).waitFor();
    await win.getByTitle("Close editor").click();
    await win.getByTestId("nav-dashboard").click();
    assert.deepEqual(errors, []);
  });

  test("The theme toggle switches the html element to dark and back, and the choice survives a relaunch", async () => {
    const own = await launch({ ui: true });
    const isDark = (w) => w.evaluate(() => document.documentElement.classList.contains("dark"));
    const pick = async (w, theme) => { await w.getByTestId("theme-toggle").click(); await w.getByTestId(`theme-${theme}`).click(); await w.getByTestId(`theme-${theme}`).waitFor({ state: "detached" }); };
    try {
      await pick(own.win, "light");
      assert.equal(await isDark(own.win), false);
      await pick(own.win, "dark");
      assert.equal(await isDark(own.win), true);
    } finally { await own.close(); }
    const again = await launch({ ui: true, userData: own.dir });
    try {
      assert.equal(await isDark(again.win), true);
      await pick(again.win, "light");
      assert.equal(await isDark(again.win), false);
    } finally { await again.close(); }
  });

  test("Adding an account and renaming it inline shows the new name and keeps the profile folder", async () => {
    await addAccount(win, "Rename me");
    const acc = (await app.call("accounts.list")).find((a) => a.name === "Rename me");
    await main(win).getByText(acc.profileDir, { exact: true }).waitFor();
    const row = main(win).locator("div.p-4", { hasText: acc.profileDir });
    await row.getByTestId("account-rename").click();
    await row.getByTestId("account-rename-input").fill("Renamed account");
    await row.getByTestId("account-rename-save").click();
    await main(win).getByText("Renamed account", { exact: true }).waitFor();
    await main(win).getByText(acc.profileDir, { exact: true }).waitFor();
    assert.equal(await main(win).getByText("Rename me", { exact: true }).count(), 0);
    const after = (await app.call("accounts.list")).find((a) => a.id === acc.id);
    assert.equal(after.name, "Renamed account");
    assert.equal(after.profileDir, acc.profileDir);
  });

  test("Running a starter workflow from its page shows it finished, counts it on the dashboard and lists it in Run history", async () => {
    await addAccount(win, "Starter runner");
    await openWorkflow(win, "Hiring post commenters");
    assert.equal(await runFromPage(win, "Starter runner"), "finished");

    const runsToday = (await app.history({ limit: 50 })).filter((r) => r.startedAt >= new Date().setHours(0, 0, 0, 0)).length;
    const invites = app.actions({ action: "connect" }).filter((a) => a.status === "sent").length;
    await win.getByTestId("nav-dashboard").click();
    await waitUntil(async () => (await text(win.getByTestId("kpi-runs").locator(".text-3xl"))) === String(runsToday), `kpi-runs to read ${runsToday}`);
    assert.match(await text(win.getByTestId("kpi-invites").locator(".text-3xl")), new RegExp(`^${invites}\\b`));
    assert.match(await text(win.getByTestId("kpi-messages").locator(".text-3xl")), /^0$/);
    assert.match(await text(win.getByTestId("kpi-active-workflows").locator(".text-3xl")), /^0$/);

    await win.getByTestId("nav-runs").click();
    const row = main(win).getByTestId("run-row").filter({ hasText: "Hiring post commenters" }).first();
    await row.waitFor();
    assert.equal(await text(row.getByTestId("run-status")), "finished");
    await row.click();
    await main(win).getByText("Send connection request").first().waitFor();
    for (const step of ["Search posts", "Post commenters", "Visit profile", "AI qualify", "AI write message"]) assert.ok(await main(win).getByRole("cell", { name: step }).count(), `${step} is in the steps table`);
    await main(win).getByText("Done on LinkedIn (2)").waitFor();
    await main(win).getByRole("link", { name: profile("ana-seeker") }).waitFor();
    await main(win).getByRole("link", { name: profile("dev-friend") }).waitFor();
  });

  test("Building a workflow in the editor by adding steps and dragging connections lets it save and run", async () => {
    await addAccount(win, "Builder");
    await win.getByTestId("nav-workflows").click();
    await main(win).getByRole("button", { name: "New workflow" }).first().click();
    await win.locator(node("start")).waitFor();

    await win.getByTestId("palette-step-urlList").click();
    await win.locator("#param-urls").fill([profile("built-one"), profile("built-two")].join("\n"));
    await chooseOption(win, win.locator("#param-itemKind"), "People (/in/ links)");
    await win.getByTestId("palette-step-visitProfile").click();
    await win.locator(`${CANVAS} .react-flow__controls-fitview`).click();
    await win.waitForTimeout(300);
    assert.ok(await win.getByTestId("editor-problems").isVisible(), "unconnected steps are listed as problems");

    await dragHandle(win, node("start"), node("urlList-"));
    await dragHandle(win, node("urlList-"), node("visitProfile-"));
    assert.equal(await win.locator(`${CANVAS} .react-flow__edge`).count(), 2);
    await win.getByTestId("editor-problems").waitFor({ state: "detached" });

    await win.getByTestId("workflow-save").click();
    await win.getByTestId("editor-dirty").waitFor({ state: "detached" });
    await win.getByTitle("Close editor").click();
    await win.locator(CANVAS).waitFor({ state: "detached" });
    assert.equal(await runFromPage(win), "finished");

    const wf = (await app.call("workflows.list")).find((w) => w.name === "Untitled workflow");
    const saved = await app.call("workflows.get", wf.id);
    assert.deepEqual(saved.nodes.map((n) => n.type), ["start", "urlList", "visitProfile"]);
    assert.equal(saved.edges.length, 2);
  });

  test("Editing an AI prompt's output fields and a Condition rule in the inspector saves the edited values", async () => {
    await openWorkflow(win, "AI fit check");
    await win.getByTestId("workflow-edit").click();
    await win.locator(node("ai")).click();
    const names = win.getByPlaceholder("name", { exact: true });
    await names.nth(2).fill("why");
    await win.getByPlaceholder("What the model should put here").nth(2).fill("one sentence on why");
    await win.locator(node("check")).click();
    await win.getByPlaceholder("value", { exact: true }).first().fill("60");
    await win.getByTestId("editor-dirty").waitFor();
    await win.getByTestId("workflow-save").click();
    await win.getByTestId("editor-dirty").waitFor({ state: "detached" });
    await win.getByTitle("Close editor").click();

    const id = (await app.call("workflows.list")).find((w) => w.name === "AI fit check").id;
    const saved = await app.call("workflows.get", id);
    const ai = saved.nodes.find((n) => n.id === "ai").params.outputFields;
    assert.deepEqual(ai.map((f) => f.name), ["fit_score", "is_decision_maker", "why"]);
    assert.equal(ai[2].description, "one sentence on why");
    const rule = saved.nodes.find((n) => n.id === "check").params.rules.rules[0];
    assert.equal(rule.field, "ai.fit_score");
    assert.equal(rule.op, "atLeast");
    assert.equal(String(rule.value), "60");
  });

  test("CRM People lists the people a run found, and a stage and tag set by hand are there on reopening", async () => {
    await addAccount(win, "CRM owner");
    await openWorkflow(win, "Hiring post commenters");
    assert.equal(await runFromPage(win, "CRM owner"), "finished");
    await win.getByTestId("nav-crm-people").click();
    const rows = main(win).getByTestId("crm-row");
    await rows.filter({ hasText: "Dev Friend" }).first().waitFor();
    await rows.filter({ hasText: "Ana Seeker" }).first().click();

    const sheet = win.getByRole("dialog");
    await sheet.getByRole("heading", { name: "Ana Seeker" }).waitFor();
    await sheet.locator("[data-slot=select-trigger]").click();
    await win.getByRole("option", { name: /^Meeting( booked)?$/ }).click();
    await sheet.getByPlaceholder("Add a tag and press Enter").fill("warm-lead");
    await sheet.getByPlaceholder("Add a tag and press Enter").press("Enter");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await win.getByText("Saved", { exact: true }).first().waitFor();
    await win.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    const tagged = rows.filter({ hasText: "Ana Seeker" }).filter({ hasText: "warm-lead" });
    await tagged.waitFor();
    assert.match(await text(tagged), /Meeting/);
    await tagged.click();
    await sheet.getByRole("heading", { name: "Ana Seeker" }).waitFor();
    assert.match(await text(sheet.locator("[data-slot=select-trigger]")), /^Meeting( booked)?$/);
    await sheet.getByText("warm-lead", { exact: true }).first().waitFor();
    await win.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("The person panel shows where an Outreach sequence has someone, and Stop automation hands them back", async () => {
    await addAccount(win, "Outreach sender");
    const acc = (await app.call("accounts.list")).find((a) => a.name === "Outreach sender");
    await app.save(chain("UI outreach", acc.id, [
      { id: "start", type: "start" },
      { id: "urls", type: "urlList", params: { urls: profile("una-follow-1st"), itemKind: "person" } },
      { id: "visit", type: "visitProfile" },
      { id: "outreach", type: "outreachSequence", params: { intro: "Hi {{firstName}}, thanks for connecting.", calendarMessage: "Pick a slot: {{calendarLink}}", replyPrompt: "Say what they mean.", cadenceDays: 2, checkEveryHours: 6, perRun: 5, perDay: 30, minGapSeconds: 0, maxGapSeconds: 0 } },
    ]));
    // The workflow was saved behind the UI's back, so reload to have the sidebar list it.
    await win.reload();
    await win.getByTestId("nav-dashboard").waitFor();
    await openWorkflow(win, "UI outreach");
    assert.equal(await runFromPage(win), "finished");

    await win.getByTestId("nav-crm-people").click();
    const row = main(win).getByTestId("crm-row").filter({ hasText: "Una Follow" });
    await row.waitFor();
    assert.match(await text(row), /Intro sent/);
    await row.click();
    const sheet = win.getByRole("dialog");
    await sheet.getByRole("heading", { name: "Una Follow" }).waitFor();
    const section = sheet.getByTestId("outreach-section");
    assert.equal(await text(section.getByTestId("outreach-state")), "Intro sent");
    await section.getByText("Hi Una", { exact: false }).first().waitFor();
    await section.getByRole("button", { name: "Stop automation" }).click();
    await waitUntil(async () => (await text(section.getByTestId("outreach-state"))) === "Handled by you", "the state to read Handled by you");
    assert.equal(await section.getByRole("button", { name: "Stop automation" }).count(), 0);
    await section.getByRole("button", { name: "Resume automation" }).waitFor();
    const contact = (await app.call("crm.contacts.list", { accountId: acc.id })).rows.find((c) => c.name === "Una Follow");
    assert.equal(contact.outreach.state, "manual");
    await win.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("Active cannot be switched on for a workflow without a schedule trigger, and says why", async () => {
    await openWorkflow(win, "B2B call qualifiers");
    const toggle = win.getByTestId("workflow-active");
    assert.equal(await toggle.isDisabled(), true);
    await toggle.click({ force: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await main(win).getByText("Inactive", { exact: true }).hover();
    await win.getByRole("tooltip").filter({ hasText: "Add a Schedule or Poll API trigger first" }).waitFor({ state: "attached" });
    const id = (await app.call("workflows.list")).find((w) => w.name === "B2B call qualifiers").id;
    assert.equal(!!(await app.call("workflows.get", id)).active, false);
  });
});
