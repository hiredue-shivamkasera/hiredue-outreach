const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, profile } = require("./harness.cjs");

const DAY = 24 * 3600_000;
const MIA = profile("mia-mentor-accepts-replies-books");
const RAJ = profile("raj-coach-accepts");
const TARA = profile("tara-mentor");
const OMAR = profile("omar-engineer");

// The built-in workflows ship in the database, so these tests use them exactly as an install gets them, only pointing them at the test account.
async function builtIns(app, accountId) {
  const list = await app.call("workflows.list");
  const byKey = Object.fromEntries(list.filter((w) => w.templateKey).map((w) => [w.templateKey, w]));
  const point = async (key) => { const wf = await app.call("workflows.get", byKey[key].id); return app.save({ ...wf, accountId }); };
  return { discovery: await point("topmate-mentor-discovery"), outreach: await point("topmate-mentor-outreach") };
}
const runOnce = async (app, wf) => app.waitForRun(await app.start(wf.id));
const contact = async (app, accountId, url) => (await app.call("crm.contacts.list", { accountId, search: url.split("/in/")[1].replace(/\/$/, "") })).rows[0];

test("a fresh install has both Topmate workflows, built in", async () => {
  const app = await launch();
  try {
    const list = await app.call("workflows.list");
    const keys = list.map((w) => w.templateKey);
    assert.ok(keys.includes("topmate-mentor-discovery"));
    assert.ok(keys.includes("topmate-mentor-outreach"));
    assert.ok(list.some((w) => w.name === "Topmate Mentor Discovery"));
  } finally { await app.close(); }
});

// Deleting a built-in is the owner's choice; bringing it back on every launch would undo it.
test("a deleted built-in workflow does not come back on the next launch", async () => {
  const first = await launch();
  const wf = (await first.call("workflows.list")).find((w) => w.templateKey === "topmate-mentor-outreach");
  await first.call("workflows.remove", wf.id);
  await first.close();
  const again = await launch({ userData: first.dir });
  try {
    assert.ok(!(await again.call("workflows.list")).some((w) => w.templateKey === "topmate-mentor-outreach"));
  } finally { await again.close(); }
});

test("discovery invites the Topmate mentors from the search page, with the note, and tags them; someone without a Topmate mention is not invited", async () => {
  const app = await launch();
  try {
    const acc = await app.createAccount("Shivam");
    const { discovery } = await builtIns(app, acc.id);
    const run = await runOnce(app, discovery);
    assert.equal(run.status, "finished", run.error);
    const invites = app.actions({ action: "connect" });
    assert.deepEqual(invites.map((a) => a.target).sort(), [MIA, RAJ, TARA].sort());
    assert.ok(invites.every((a) => a.status === "sent" && /Topmate/.test(a.note) && /HireDue/.test(a.note)));
    assert.ok(!invites.some((a) => a.target === OMAR));
    for (const url of [MIA, RAJ, TARA]) assert.ok((await contact(app, acc.id, url)).tags.includes("topmate-mentor"));

    // The CRM is the record of who was contacted; a second run must move on rather than re-invite.
    const again = await runOnce(app, discovery);
    assert.equal(again.status, "finished");
    assert.equal(app.actions({ action: "connect" }).length, 3);
  } finally { await app.close(); }
});

test("an account that cannot add notes still sends its invites, without a note", async () => {
  const app = await launch({ scenario: "no-note" });
  try {
    const acc = await app.createAccount("Free account");
    const { discovery } = await builtIns(app, acc.id);
    const run = await runOnce(app, discovery);
    assert.equal(run.status, "finished", run.error);
    const invites = app.actions({ action: "connect" });
    assert.equal(invites.length, 3);
    assert.ok(invites.every((a) => a.status === "sent" && a.note === null));
    assert.ok(run.events.some((e) => /cannot add a note/.test(e.message || "")));
  } finally { await app.close(); }
});

test("the outreach workflow walks each mentor through intro, calendar link or follow-ups, booking and drop", async () => {
  const day0 = await launch();
  const acc = await day0.createAccount("Shivam");
  const { discovery, outreach } = await builtIns(day0, acc.id);
  await day0.call("settings.set", { calendarLink: "https://cal.com/shivam/intro" });
  try {
    await runOnce(day0, discovery);
    const first = await runOnce(day0, outreach);
    assert.equal(first.status, "finished", first.error);
    const intros = day0.actions({ action: "message" });
    assert.deepEqual(intros.map((a) => a.target).sort(), [MIA, RAJ].sort());
    assert.ok(intros.every((a) => /launched HireDue/.test(a.text) && /^Hi Mia,|^Hi Raj,/.test(a.text) && !/http/.test(a.text)));
    assert.equal((await contact(day0, acc.id, TARA)).outreach.state, "invited");
    assert.equal((await contact(day0, acc.id, MIA)).outreach.state, "intro_sent");

    // A look a few minutes later must not open anyone's conversation again.
    const reads = day0.actions({ action: "thread.read" }).length;
    await runOnce(day0, outreach);
    assert.equal(day0.actions({ action: "thread.read" }).length, reads);
  } finally { await day0.close(); }

  const day2 = await launch({ userData: day0.dir, env: { OUTREACH_CLOCK_OFFSET_MS: String(2.5 * DAY) } });
  try {
    const run = await runOnce(day2, outreach);
    assert.equal(run.status, "finished", run.error);
    const sends = day2.actions({ action: "followup" });
    const toMia = sends.find((a) => a.target === MIA);
    const toRaj = sends.find((a) => a.target === RAJ);
    assert.match(toMia.text, /https:\/\/cal\.com\/shivam\/intro/);
    assert.match(toRaj.text, /bumping this/);
    assert.equal((await contact(day2, acc.id, MIA)).stage, "calendar_sent");
    assert.equal((await contact(day2, acc.id, RAJ)).outreach.state, "followup1_sent");
  } finally { await day2.close(); }

  const day5 = await launch({ userData: day0.dir, env: { OUTREACH_CLOCK_OFFSET_MS: String(5 * DAY) } });
  try {
    await runOnce(day5, outreach);
    const mia = await contact(day5, acc.id, MIA);
    assert.equal(mia.outreach.state, "booked");
    assert.equal(mia.stage, "meeting");
    assert.equal((await contact(day5, acc.id, RAJ)).outreach.state, "followup2_sent");
  } finally { await day5.close(); }

  const day8 = await launch({ userData: day0.dir, env: { OUTREACH_CLOCK_OFFSET_MS: String(8 * DAY) } });
  try {
    const before = day8.actions({ action: "followup" }).length;
    await runOnce(day8, outreach);
    const raj = await contact(day8, acc.id, RAJ);
    assert.equal(raj.outreach.state, "dropped");
    assert.equal(raj.stage, "dropped");
    assert.equal(day8.actions({ action: "followup" }).length, before, "nothing more goes to a booked or dropped person");
  } finally { await day8.close(); }
});

test("People can be filtered by the workflow that found them and by outreach state", async () => {
  const app = await launch();
  try {
    const acc = await app.createAccount("Shivam");
    const { discovery, outreach } = await builtIns(app, acc.id);
    await app.call("settings.set", { calendarLink: "https://cal.com/shivam/intro" });
    await runOnce(app, discovery);
    await runOnce(app, outreach);
    const found = await app.call("crm.contacts.list", { foundBy: discovery.id });
    // Omar is rejected on the search page, so he never becomes a CRM record at all.
    assert.deepEqual(found.rows.map((c) => c.profileUrl).sort(), [MIA, RAJ, TARA].sort());
    const introSent = await app.call("crm.contacts.list", { outreachState: "intro_sent" });
    assert.deepEqual(introSent.rows.map((c) => c.profileUrl).sort(), [MIA, RAJ].sort());
    const tara = (await app.call("crm.contacts.list", { search: "tara-mentor" })).rows[0];
    const stopped = await app.call("crm.contacts.setOutreachState", tara.id, "stop");
    assert.equal(stopped.outreach.state, "manual");
    const resumed = await app.call("crm.contacts.setOutreachState", tara.id, "resume");
    assert.equal(resumed.outreach.state, "invited");
  } finally { await app.close(); }
});
