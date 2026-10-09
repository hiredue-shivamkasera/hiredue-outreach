// The CRM and follow-ups end to end: people filed from runs, stages driven by the ledger and by hand, the CRM steps, follow-up enrolment and the due sends, and account rename.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, chain, steps, profile, postLink, postUrn } = require("./harness.cjs");

const DAY = 24 * 60 * 60 * 1000;
const start = { id: "start", type: "start" };
const urls = (...slugs) => ({ id: "urls", type: "urlList", params: { urls: slugs.map(profile).join("\n"), itemKind: "person" } });
const visit = { id: "visit", type: "visitProfile" };
const connect = { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } };
const message = { id: "message", type: "message", params: { text: "Hi {{firstName}}, quick question.", perDay: 30 } };
const followUp = { id: "followUp", type: "followUp", params: { steps: [{ afterDays: 1, text: "Hi {{firstName}}, following up." }, { afterDays: 2, text: "Hi {{firstName}}, last nudge." }], stopOnReply: "yes", perDay: 30 } };

// Stream C builds the CRM in parallel; until its IPC exists these tests say so instead of failing.
async function needs(t, app, fnPath) {
  if (await app.has(fnPath)) return true;
  t.skip(`waiting for stream C: window.outreach.${fnPath} is not exposed yet`);
  return false;
}
const contactOf = async (app, accountId, slug) => (await app.call("crm.contacts.list", { accountId, search: slug, limit: 50 })).rows.find((c) => c.profileUrl === profile(slug));

describe("CRM", () => {
  let app;
  before(async () => { app = await launch(); });
  after(() => app?.close());

  test("A run files every person it produced into the CRM once per account, keeping the newest snapshot", async (t) => {
    if (!(await needs(t, app, "crm.contacts.list"))) return;
    const a = await app.createAccount("crm filing");
    const wf = await app.save(chain("crm filing", a.id, [start, urls("ana-seeker", "ben-builder"), visit]));
    await app.waitForRun(await app.start(wf.id));
    const run2 = await app.waitForRun(await app.start(wf.id));
    const { rows, total } = await app.call("crm.contacts.list", { accountId: a.id });
    assert.equal(total, 2);
    const ana = rows.find((c) => c.profileUrl === profile("ana-seeker"));
    assert.equal(ana.name, "Ana Seeker");
    assert.equal(ana.headline, "Frontend engineer, open to work");
    assert.equal(ana.stage, "new");
    assert.equal(ana.accountName, "crm filing");
    assert.equal(ana.source.workflowId, wf.id);
    assert.equal((await app.call("crm.contacts.get", ana.id)).timeline.filter((e) => e.kind === "run" && e.runId === run2.id).length, 1);
  });

  test("Stages follow the ledger forward: an invite makes invited, a first-degree person connected, a message messaged", async (t) => {
    if (!(await needs(t, app, "crm.contacts.list"))) return;
    const a = await app.createAccount("crm stages");
    await app.run(chain("crm stages connect", a.id, [start, urls("stage-new", "stage-1st"), visit, connect]));
    assert.equal((await contactOf(app, a.id, "stage-new")).stage, "invited");
    assert.equal((await contactOf(app, a.id, "stage-1st")).stage, "connected");
    await app.run(chain("crm stages message", a.id, [start, urls("stage-1st"), visit, message]));
    assert.equal((await contactOf(app, a.id, "stage-1st")).stage, "messaged");
  });

  test("A stage set by hand is recorded on the timeline and never moved back by a later run", async (t) => {
    if (!(await needs(t, app, "crm.contacts.update"))) return;
    const a = await app.createAccount("crm manual");
    await app.run(chain("crm manual", a.id, [start, urls("hand-1st"), visit]));
    const c = await contactOf(app, a.id, "hand-1st");
    const updated = await app.call("crm.contacts.update", c.id, { stage: "qualified", tags: ["vip"], notes: "Met at a meetup." });
    assert.equal(updated.stage, "qualified");
    await app.run(chain("crm manual message", a.id, [start, urls("hand-1st"), visit, message]));
    const after = await app.call("crm.contacts.get", c.id);
    assert.equal(after.stage, "qualified");
    assert.deepEqual(after.tags, ["vip"]);
    assert.equal(after.notes, "Met at a meetup.");
    assert.ok(after.timeline.some((e) => e.kind === "stage"));
    assert.ok((await app.call("crm.tags")).includes("vip"));
  });

  test("Update CRM sets the stage, adds tags and writes a note from the template", async (t) => {
    if (!(await needs(t, app, "crm.contacts.get"))) return;
    const a = await app.createAccount("crm update");
    const run = await app.run(chain("crm update", a.id, [start, urls("ben-builder"), visit, { id: "crm", type: "crmUpdate", params: { stage: "meeting", addTags: "founder, warm", note: "{{firstName}} runs {{headline}}" } }]));
    assert.equal(run.status, "finished", run.error);
    const c = await app.call("crm.contacts.get", (await contactOf(app, a.id, "ben-builder")).id);
    assert.equal(c.stage, "meeting");
    assert.deepEqual([...c.tags].sort(), ["founder", "warm"]);
    assert.ok(c.timeline.some((e) => e.kind === "note" && e.text.includes("Ben runs Founder at Ledgerly")));
    assert.deepEqual((await app.call("crm.contacts.list", { accountId: a.id, stage: "meeting", tag: "warm" })).rows.map((x) => x.profileUrl), [profile("ben-builder")]);
  });

  test("From CRM starts a run from this account's contacts filtered by stage and tag", async (t) => {
    if (!(await needs(t, app, "crm.contacts.list"))) return;
    const a = await app.createAccount("crm source");
    await app.run(chain("crm source seed", a.id, [start, urls("src-one", "src-two"), visit, { id: "crm", type: "crmUpdate", params: { stage: "keep", addTags: "", note: "" } }]));
    const one = await contactOf(app, a.id, "src-one");
    await app.call("crm.contacts.update", one.id, { tags: ["pick"] });
    const run = await app.run(chain("crm source", a.id, [start, { id: "source", type: "crmSource", params: { stage: "any", tag: "pick", limit: 25 } }, connect]));
    assert.equal(run.status, "finished", run.error);
    assert.deepEqual(steps(run).source.counts, { out: 1 });
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => x.target), [profile("src-one")]);
  });

  test("Posts a run engaged with are filed with what was done to them", async (t) => {
    if (!(await needs(t, app, "crm.posts.list"))) return;
    const a = await app.createAccount("crm posts");
    await app.run(chain("crm posts", a.id, [start, { id: "urls", type: "urlList", params: { urls: postLink(3), itemKind: "post" } }, { id: "like", type: "like", params: { reaction: "like", perDay: 50 } }]));
    const { rows } = await app.call("crm.posts.list", { accountId: a.id });
    const p = rows.find((x) => x.postKey === postUrn(3) || x.postUrl === postLink(3));
    assert.ok(p, "the liked post is in the CRM");
    assert.equal(p.engagement.like, "sent");
  });

  test("Check replies splits people by whether they answered after this account's message, and marks repliers", async (t) => {
    if (!(await needs(t, app, "crm.contacts.list"))) return;
    const a = await app.createAccount("check replies");
    await app.run(chain("check replies send", a.id, [start, urls("cr-replies-1st", "cr-quiet-1st"), visit, message]));
    const run = await app.run(chain("check replies", a.id, [start, urls("cr-replies-1st", "cr-quiet-1st", "cr-stranger"), { id: "check", type: "checkReplies" }]));
    assert.equal(run.status, "finished", run.error);
    assert.deepEqual(run.outputs.check.replied.map((p) => p.profileUrl), [profile("cr-replies-1st")]);
    assert.deepEqual(run.outputs.check.noReply.map((p) => p.profileUrl), [profile("cr-quiet-1st")]);
    // A second-degree person has no conversation to read, which is an error, never a no.
    assert.equal(steps(run).check.failedItems, 1);
    assert.equal((await contactOf(app, a.id, "cr-replies-1st")).stage, "replied");
  });

  test("Renaming an account keeps its browser profile and its history", async (t) => {
    if (!(await needs(t, app, "accounts.rename"))) return;
    const a = await app.createAccount("before rename");
    await app.run(chain("rename one", a.id, [start, urls("rn-one"), visit]));
    await app.call("accounts.rename", a.id, "  after rename  ");
    assert.equal((await app.call("accounts.list")).find((x) => x.id === a.id).name, "after rename");
    await assert.rejects(app.call("accounts.rename", a.id, "   "));
    await app.run(chain("rename two", a.id, [start, urls("rn-two"), visit]));
    const dirs = app.actions({ accountId: a.id, action: "session.open" }).map((x) => x.profileDir);
    assert.equal(dirs.length, 2);
    assert.equal(dirs[0], dirs[1]);
    assert.ok((await app.history({})).filter((r) => r.accountId === a.id).every((r) => r.accountName === "after rename"));
  });
});

// Follow-ups are due days after the message, so these tests enrol in one launch and relaunch the same data with the clock moved forward.
describe("follow-ups", () => {
  const apps = [];
  after(async () => { for (const a of apps) await a.close(); });
  let first, account, wf;

  before(async () => {
    first = await launch();
    apps.push(first);
  });

  test("Enrolling books follow-ups only for people this account messaged, and sends nothing yet", async (t) => {
    if (!(await needs(t, first, "followups.list"))) return;
    account = await first.createAccount("follow-ups");
    wf = await first.save(chain("follow-ups", account.id, [start, urls("fu-quiet-1st", "fu-replies-1st", "fu-cancel-1st", "fu-stranger"), visit, message, followUp]));
    const run = await first.waitForRun(await first.start(wf.id));
    assert.equal(run.status, "finished", run.error);
    // The stranger is second degree, so no message went out and there is nothing to follow up.
    assert.deepEqual(steps(run).followUp.counts, { out: 3 });
    const rows = await first.call("followups.list", { accountId: account.id });
    assert.deepEqual(rows.map((r) => r.profileUrl).sort(), ["fu-cancel-1st", "fu-quiet-1st", "fu-replies-1st"].map(profile).sort());
    assert.ok(rows.every((r) => r.status === "active" && r.totalSteps === 2 && r.nextDueAt > Date.now() + 0.9 * DAY));
    assert.equal(first.actions({ accountId: account.id, action: "followup" }).length, 0);

    const again = await first.waitForRun(await first.start(wf.id));
    assert.equal(again.outputs.followUp?.out.length ?? 0, 0);
    assert.equal((await first.call("followups.list", { accountId: account.id })).length, 3);

    const cancel = rows.find((r) => r.profileUrl === profile("fu-cancel-1st"));
    await first.call("followups.cancel", cancel.id);
    assert.equal((await first.call("followups.list", { accountId: account.id, status: "cancelled" }))[0].id, cancel.id);
  });

  test("When follow-ups come due the scheduler sends the next message to the silent person and stops for the one who replied", async (t) => {
    if (!account) return t.skip("waiting for stream C: enrolment did not run");
    await first.close();
    const later = await launch({ userData: first.dir, env: { OUTREACH_CLOCK_OFFSET_MS: String(1.5 * DAY) } });
    apps.push(later);
    const run = await later.waitFor(async () => (await later.history({})).find((r) => r.firedBy === "followUp" && r.status !== "running"), { what: "a follow-up run", timeout: 20_000 });
    assert.equal(run.status, "finished");
    assert.equal(run.accountId, account.id);
    assert.deepEqual(later.actions({ accountId: account.id, action: "followup" }).map((x) => [x.target, x.status, x.text]), [[profile("fu-quiet-1st"), "sent", "Hi Fu, following up."]]);
    const rows = await later.call("followups.list", { accountId: account.id });
    const byUrl = Object.fromEntries(rows.map((r) => [r.profileUrl, r]));
    assert.equal(byUrl[profile("fu-quiet-1st")].status, "active");
    assert.equal(byUrl[profile("fu-quiet-1st")].stepIndex, 1);
    assert.equal(byUrl[profile("fu-replies-1st")].status, "replied");
    assert.equal(byUrl[profile("fu-cancel-1st")].status, "cancelled");
    assert.equal((await contactOf(later, account.id, "fu-replies-1st")).stage, "replied");
    // Nothing else is due for a day, so a manual check sends nothing more.
    await later.call("followups.runNow", account.id);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(later.actions({ accountId: account.id, action: "followup" }).length, 1);
  });
});
