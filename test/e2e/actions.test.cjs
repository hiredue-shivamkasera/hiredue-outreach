// Each LinkedIn action step through a minimal workflow, plus the account protections around them: caps, never twice, run history, and one ledger per account.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, chain, steps, profile, postUrn, postLink } = require("./harness.cjs");

let app;
before(async () => { app = await launch(); });
after(() => app?.close());

const urls = (itemKind, ...links) => ({ type: "urlList", params: { urls: links.join("\n"), itemKind } });
const start = { id: "start", type: "start" };
const outward = (accountId, action) => app.actions({ accountId, action });

test("Connect without a note sends a plain invite and passes the person on", async () => {
  const a = await app.createAccount("connect plain");
  const run = await app.run(chain("connect plain", a.id, [start, urls("person", profile("sam-new")), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(outward(a.id, "connect").map((x) => [x.target, x.status, x.note]), [[profile("sam-new"), "sent", null]]);
  assert.equal(run.outputs.connect.out.length, 1);
  assert.deepEqual(run.actions.map((x) => [x.action, x.target, x.status]), [["connect", profile("sam-new"), "sent"]]);
});

test("Connect with a note fills the template from the person", async () => {
  const a = await app.createAccount("connect note");
  const run = await app.run(chain("connect note", a.id, [start, urls("person", profile("sam-new")), { id: "visit", type: "visitProfile" }, { id: "connect", type: "connect", params: { note: "Hi {{firstName}}, saw you are in {{location}}.", perDay: 20, perWeek: 100 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.equal(outward(a.id, "connect")[0].note, "Hi Sam, saw you are in Bengaluru, India.");
  assert.equal(run.outputs.connect.out[0].invitedWith, "Hi Sam, saw you are in Bengaluru, India.");
});

test("Connect records a first-degree person as connected and does not pass them on", async () => {
  const a = await app.createAccount("connect 1st");
  const run = await app.run(chain("connect 1st", a.id, [start, urls("person", profile("dev-friend")), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.actions.map((x) => x.status), ["connected"]);
  assert.equal(steps(run).connect.counts.out, 0);
});

test("Message reaches first-degree connections only and never writes into an existing conversation", async () => {
  const a = await app.createAccount("message");
  const run = await app.run(chain("message", a.id, [start, urls("person", profile("mia-1st"), profile("noah-2nd"), profile("eli-founder")), { id: "visit", type: "visitProfile" }, { id: "message", type: "message", params: { text: "Hi {{firstName}}, quick question about your work.", perDay: 30 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(outward(a.id, "message").map((x) => [x.target, x.status]), [[profile("mia-1st"), "sent"], [profile("noah-2nd"), "not_connected"], [profile("eli-founder"), "already_messaged"]]);
  assert.equal(outward(a.id, "message")[0].text, "Hi Mia, quick question about your work.");
  assert.deepEqual(run.outputs.message.out.map((p) => p.profileUrl), [profile("mia-1st")]);
});

// A link pasted without a Visit profile step carries no name, and the message went out as "Hi , ..." to a real person.
test("A message whose placeholder has no value is not sent with a blank in its place", async () => {
  const a = await app.createAccount("blank placeholder");
  await app.run(chain("blank placeholder", a.id, [start, urls("person", profile("zed-1st")), { id: "message", type: "message", params: { text: "Hi {{firstName}}, quick question.", perDay: 30 } }]));
  assert.equal(outward(a.id, "message").filter((x) => x.status === "sent" && /Hi ,/.test(x.text)).length, 0);
});

test("Like reacts with the chosen reaction and passes the post on", async () => {
  const a = await app.createAccount("like");
  const wf = chain("like", a.id, [start, urls("post", postLink(3)), { id: "like", type: "like", params: { reaction: "celebrate", perDay: 50 } }]);
  const run = await app.run(wf);
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(outward(a.id, "like").map((x) => [x.target, x.status, x.reaction]), [[postUrn(3), "sent", "celebrate"]]);
  assert.equal(run.outputs.like.out.length, 1);
});

test("Comment posts the rendered text under each post", async () => {
  const a = await app.createAccount("comment");
  const run = await app.run(chain("comment", a.id, [start, urls("post", postLink(3), postLink(4)), { id: "comment", type: "comment", params: { text: "Agreed, the follow-up the same day is the part people skip.", perDay: 15 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(outward(a.id, "comment").map((x) => [x.target, x.text]), [[postUrn(3), "Agreed, the follow-up the same day is the part people skip."], [postUrn(4), "Agreed, the follow-up the same day is the part people skip."]]);
  assert.equal(run.outputs.comment.out[0].commented, "Agreed, the follow-up the same day is the part people skip.");
});

test("Repost goes out plain when thoughts are blank and with words on top when they are not", async () => {
  const a = await app.createAccount("repost");
  const plain = await app.run(chain("repost plain", a.id, [start, urls("post", postLink(3)), { id: "repost", type: "repost", params: { thoughts: "", perDay: 5 } }]));
  const withWords = await app.run(chain("repost words", a.id, [start, urls("post", postLink(4)), { id: "repost", type: "repost", params: { thoughts: "Worth a read.", perDay: 5 } }]));
  assert.equal(plain.status, "finished", plain.error);
  assert.equal(withWords.status, "finished", withWords.error);
  assert.deepEqual(outward(a.id, "repost").map((x) => [x.target, x.thoughts]), [[postUrn(3), null], [postUrn(4), "Worth a read."]]);
});

test("Follow follows pages and people and passes on only what it newly followed", async () => {
  const a = await app.createAccount("follow");
  const pages = await app.run(chain("follow pages", a.id, [start, urls("page", "https://www.linkedin.com/company/acme/", "https://www.linkedin.com/company/already-followed/"), { id: "follow", type: "follow", params: { perDay: 30 } }]));
  const people = await app.run(chain("follow people", a.id, [start, urls("person", profile("ben-builder")), { id: "follow", type: "follow", params: { perDay: 30 } }]));
  assert.equal(pages.status, "finished", pages.error);
  assert.equal(people.status, "finished", people.error);
  assert.deepEqual(outward(a.id, "follow").map((x) => [x.target, x.status]), [["https://www.linkedin.com/company/acme/", "sent"], ["https://www.linkedin.com/company/already-followed/", "already"], [profile("ben-builder"), "sent"]]);
  assert.deepEqual(pages.outputs.follow.out.map((p) => p.pageUrl), ["https://www.linkedin.com/company/acme/"]);
});

test("A daily cap stops sending at the limit and the next run sends nothing more that day", async () => {
  const a = await app.createAccount("cap");
  const people = ["cap-one", "cap-two", "cap-three", "cap-four"].map(profile);
  const first = await app.run(chain("cap first", a.id, [start, urls("person", ...people), { id: "connect", type: "connect", params: { note: "", perDay: 2, perWeek: 100 } }]));
  assert.equal(first.status, "finished", first.error);
  assert.equal(first.outputs.connect.out.length, 2);
  const second = await app.run(chain("cap second", a.id, [start, urls("person", profile("cap-five")), { id: "connect", type: "connect", params: { note: "", perDay: 2, perWeek: 100 } }]));
  assert.equal(second.status, "finished", second.error);
  assert.deepEqual(outward(a.id, "connect").map((x) => x.target), people.slice(0, 2));
});

test("A weekly cap holds even when the daily cap has room", async () => {
  const a = await app.createAccount("weekly cap");
  const run = await app.run(chain("weekly", a.id, [start, urls("person", profile("wk-one"), profile("wk-two"), profile("wk-three")), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 1 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.equal(outward(a.id, "connect").length, 1);
});

test("The same person is never invited twice from one account, across runs and across workflows", async () => {
  const a = await app.createAccount("never twice");
  const connectSam = (name) => chain(name, a.id, [start, urls("person", profile("sam-once")), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]);
  const wf = await app.save(connectSam("first workflow"));
  await app.waitForRun(await app.start(wf.id));
  const again = await app.waitForRun(await app.start(wf.id));
  const other = await app.run(connectSam("second workflow"));
  assert.equal(again.status, "finished", again.error);
  assert.equal(other.status, "finished", other.error);
  assert.equal(outward(a.id, "connect").length, 1);
  assert.equal(again.outputs.connect?.out.length ?? 0, 0);
  assert.ok(other.events.some((e) => /done from this account before, skipped/.test(e.message || "")));
});

test("A post liked by one workflow is not liked again by another on the same account", async () => {
  const a = await app.createAccount("never twice posts");
  const likeIt = (name) => chain(name, a.id, [start, urls("post", postLink(1)), { id: "like", type: "like", params: { reaction: "like", perDay: 50 } }]);
  await app.run(likeIt("likes A"));
  await app.run(likeIt("likes B"));
  assert.equal(outward(a.id, "like").length, 1);
});

test("Run history keeps the graph as it ran, the step summary and every action, after the workflow is edited", async () => {
  const a = await app.createAccount("history");
  const wf = await app.save(chain("history", a.id, [start, urls("person", profile("hist-one"), profile("dev-friend")), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]));
  const run = await app.waitForRun(await app.start(wf.id));
  await app.save({ ...wf, nodes: wf.nodes.map((n) => (n.id === "connect" ? { ...n, params: { ...n.params, note: "edited later" } } : n)) });

  const rows = await app.history({ workflowId: wf.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, run.id);
  assert.equal(rows[0].status, "finished");
  assert.equal(rows[0].workflowName, "history");
  assert.equal(rows[0].accountName, "history");
  assert.deepEqual(rows[0].actions, { connect: { sent: 1, connected: 1 } });
  assert.deepEqual(rows[0].steps.map((s) => s.type), ["start", "urlList", "connect"]);
  assert.deepEqual(rows[0].summary.steps.map((s) => [s.type, s.state]), [["start", "done"], ["urlList", "done"], ["connect", "done"]]);

  const stored = await app.getRun(run.id);
  assert.equal(stored.graph.nodes.find((n) => n.id === "connect").params.note, "");
  assert.equal(stored.graphIsCurrent, false);
  assert.deepEqual(stored.actions.map((x) => [x.target, x.status]), [[profile("hist-one"), "sent"], [profile("dev-friend"), "connected"]]);
  assert.equal(stored.outputs.urlList1.out.length, 2);
  assert.ok(stored.finishedAt >= stored.startedAt);
  assert.equal((await app.history({ status: "failed", workflowId: wf.id })).length, 0);
});

test("Two accounts use separate browser profiles, separate ledgers and separate caps", async () => {
  const one = await app.createAccount("account one");
  const two = await app.createAccount("account two");
  const connectBoth = (acc) => chain(`isolation ${acc.name}`, acc.id, [start, urls("person", profile("shared-lead"), profile("other-lead")), { id: "connect", type: "connect", params: { note: "", perDay: 1, perWeek: 100 } }]);
  await app.run(connectBoth(one));
  const r2 = await app.run(connectBoth(two));
  assert.equal(r2.status, "finished", r2.error);
  // Account one's invite and used-up cap say nothing about account two.
  assert.deepEqual(outward(one.id, "connect").map((x) => x.target), [profile("shared-lead")]);
  assert.deepEqual(outward(two.id, "connect").map((x) => x.target), [profile("shared-lead")]);
  const dirs = [one, two].map((acc) => app.actions({ accountId: acc.id, action: "session.open" })[0].profileDir);
  assert.notEqual(dirs[0], dirs[1]);
  assert.ok(dirs[0].includes(one.id) && dirs[1].includes(two.id));
  assert.deepEqual((await app.call("accounts.actions", one.id)).map((x) => x.target), [profile("shared-lead")]);
});

test("A run needs an account and a valid graph before anything opens", async () => {
  const noAccount = await app.save(chain("no account", null, [start, urls("person", profile("x-one")), { id: "connect", type: "connect", params: { note: "" } }]));
  await assert.rejects(app.start(noAccount.id), /Pick a LinkedIn account/);
  const a = await app.createAccount("invalid");
  const invalid = await app.save(chain("invalid", a.id, [start, { type: "urlList", params: { urls: "", itemKind: "person" } }]));
  await assert.rejects(app.start(invalid.id), /required/);
  assert.equal(app.actions({ accountId: a.id }).length, 0);
});
