// The three starter workflows, run end to end against the scripted LinkedIn: every step's counts and every invite, reaction and comment they cause.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, steps, profile, postUrn } = require("./harness.cjs");

let app;
before(async () => { app = await launch(); });
after(() => app?.close());

async function runTemplate(name) {
  const account = await app.createAccount(name);
  const wf = (await app.call("workflows.list")).find((w) => w.name === name);
  assert.ok(wf, `starter workflow "${name}" exists on first launch`);
  const full = await app.call("workflows.get", wf.id);
  const run = await app.run({ ...full, accountId: account.id });
  return { run, s: steps(run), done: app.actions({ accountId: account.id }).filter((a) => a.action !== "session.open") };
}

test("Hiring post commenters invites the qualified commenter and skips the one already connected", async () => {
  const { run, s, done } = await runTemplate("Hiring post commenters");
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(s.posts.counts, { out: 2 });
  // Ana commented on both posts, so she is kept once; Cara's "Nice post" matches none of the words.
  assert.deepEqual(s.commenters.counts, { out: 2 });
  assert.deepEqual(s.profile.counts, { out: 2 });
  assert.deepEqual(s.qualify.counts, { pass: 2, fail: 0 });
  assert.deepEqual(s.write.counts, { out: 2 });
  assert.deepEqual(s.connect.counts, { out: 1 });
  assert.deepEqual(done.map((a) => [a.action, a.target, a.status]), [["connect", profile("ana-seeker"), "sent"], ["connect", profile("dev-friend"), "connected"]]);
  assert.match(done[0].note, /^Good to meet you, Ana\./);
});

test("B2B call qualifiers invites only the founder among second-degree people", async () => {
  const { run, s, done } = await runTemplate("B2B call qualifiers");
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(s.people.counts, { out: 3 });
  assert.deepEqual(s.qualify.counts, { pass: 1, fail: 2 });
  assert.deepEqual(s.connect.counts, { out: 1 });
  assert.deepEqual(done.map((a) => [a.action, a.target, a.status]), [["connect", profile("ben-builder"), "sent"]]);
});

test("Daily post engagement, run by hand, reacts Insightful and comments on the substantive post only", async () => {
  const { run, s, done } = await runTemplate("Daily post engagement");
  assert.equal(run.status, "finished", run.error);
  assert.equal(run.firedBy, "manual");
  assert.deepEqual(s.posts.counts, { out: 2 });
  assert.deepEqual(s.qualify.counts, { pass: 1, fail: 1 });
  assert.deepEqual(s.like.counts, { out: 1 });
  assert.deepEqual(s.comment.counts, { out: 1 });
  assert.deepEqual(done.map((a) => [a.action, a.target, a.status]), [["like", postUrn(3), "sent"], ["comment", postUrn(3), "sent"]]);
  assert.equal(done[0].reaction, "insightful");
  assert.match(done[1].text, /^Useful point about Three lessons from/);
});
