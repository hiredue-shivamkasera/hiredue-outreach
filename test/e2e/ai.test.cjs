// The AI prompt, Condition and Feed posts steps end to end: answers stored on items, branching on them, and acting on posts from the home feed.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, chain, steps, profile, postUrn } = require("./harness.cjs");

let app;
before(async () => { app = await launch(); });
after(() => app?.close());

const start = { id: "start", type: "start" };
const urls = (...slugs) => ({ id: "urls", type: "urlList", params: { urls: slugs.map(profile).join("\n"), itemKind: "person" } });
const visit = { id: "visit", type: "visitProfile" };
const FIELDS = [
  { name: "score", type: "number", description: "0-100 fit" },
  { name: "decides", type: "boolean", description: "signs off on purchases" },
  { name: "tier", type: "choice", choices: "hot, warm, cold", description: "how soon to reach out" },
  { name: "reason", type: "text", description: "one sentence" },
];
const aiPrompt = (params = {}) => ({ id: "ai", type: "aiPrompt", params: { prompt: "Is {{firstName}} a buyer for us?", outputFields: FIELDS, outputKey: "ai", ...params } });

test("AI fit check invites only the person the AI scores as a decision maker", async () => {
  const account = await app.createAccount("AI fit check");
  const wf = (await app.call("workflows.list")).find((w) => w.name === "AI fit check");
  assert.ok(wf, "the AI fit check starter workflow exists");
  const run = await app.run({ ...(await app.call("workflows.get", wf.id)), accountId: account.id });
  assert.equal(run.status, "finished", run.error);
  const s = steps(run);
  assert.deepEqual(s.people.counts, { out: 3 });
  assert.deepEqual(s.ai.counts, { out: 3 });
  assert.deepEqual(s.check.counts, { true: 1, false: 2 });
  assert.deepEqual(app.actions({ accountId: account.id, action: "connect" }).map((x) => [x.target, x.status]), [[profile("ben-builder"), "sent"]]);
  assert.deepEqual(run.outputs.connect.out[0].ai, { fit_score: 85, is_decision_maker: true, reason: "Matches what the prompt asks for." });
});

test("AI prompt stores a typed answer under its output key for later templates to use", async () => {
  const a = await app.createAccount("ai prompt");
  const run = await app.run(chain("ai prompt", a.id, [start, urls("ben-builder"), visit, aiPrompt({ outputKey: "lead" }), { id: "connect", type: "connect", params: { note: "Hi {{firstName}}, you look {{lead.tier}}: {{lead.reason}}", perDay: 20, perWeek: 100 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.outputs.ai.out[0].lead, { score: 85, decides: true, tier: "hot", reason: "Matches what the prompt asks for." });
  assert.equal(app.actions({ accountId: a.id, action: "connect" })[0].note, "Hi Ben, you look hot: Matches what the prompt asks for.");
});

test("An AI prompt answer missing a field is an item error and that item goes no further", async () => {
  const a = await app.createAccount("ai unreadable");
  const run = await app.run(chain("ai unreadable", a.id, [start, urls("ben-builder", "unreadable-person", "ana-seeker"), visit, aiPrompt(), { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.equal(steps(run).ai.failedItems, 1);
  assert.deepEqual(run.outputs.ai.out.map((p) => p.profileUrl), [profile("ben-builder"), profile("ana-seeker")]);
  assert.ok(run.events.some((e) => e.type === "item.failed" && /unreadable AI answer: "score" is missing/.test(e.message)));
});

test("Condition sends each item down true or false and only the true branch acts", async () => {
  const a = await app.createAccount("condition all");
  const rules = { match: "all", rules: [{ field: "ai.score", op: "atLeast", value: 70 }, { field: "ai.tier", op: "equals", value: "hot" }] };
  const wf = chain("condition all", a.id, [start, urls("ben-builder", "ana-seeker", "eli-founder"), visit, aiPrompt(), { id: "check", type: "condition", params: { rules } }, { id: "connect", from: "true", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } }]);
  wf.nodes.push({ id: "follow", type: "follow", position: { x: 1500, y: 300 }, params: { perDay: 30 } });
  wf.edges.push({ id: "false-follow", source: "check", sourceHandle: "false", target: "follow" });
  const run = await app.run(wf);
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(steps(run).check.counts, { true: 2, false: 1 });
  // Eli is a first-degree founder: true branch, recorded as already connected.
  assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => [x.target, x.status]), [[profile("ben-builder"), "sent"], [profile("eli-founder"), "connected"]]);
  assert.deepEqual(app.actions({ accountId: a.id, action: "follow" }).map((x) => x.target), [profile("ana-seeker")]);
});

test("Condition with match any passes an item that meets one rule, and a rule on a missing field is false", async () => {
  const a = await app.createAccount("condition any");
  const rules = { match: "any", rules: [{ field: "nothere.score", op: "atLeast", value: 1 }, { field: "headline", op: "contains", value: "student" }] };
  const run = await app.run(chain("condition any", a.id, [start, urls("cara-student", "ben-builder"), visit, { id: "check", type: "condition", params: { rules } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.outputs.check.true.map((p) => p.profileUrl), [profile("cara-student")]);
  assert.deepEqual(run.outputs.check.false.map((p) => p.profileUrl), [profile("ben-builder")]);
});

test("Feed posts reads the home feed and later steps act on those posts", async () => {
  const a = await app.createAccount("feed");
  const run = await app.run(chain("feed", a.id, [start, { id: "feed", type: "feedPosts", params: { limit: 2 } }, { id: "like", type: "like", params: { reaction: "like", perDay: 50 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(steps(run).feed.counts, { out: 2 });
  assert.deepEqual(app.actions({ accountId: a.id, action: "like" }).map((x) => x.target), [postUrn(3), postUrn(4)]);
});

test("An AI prompt can judge feed posts and a Condition picks which to comment on", async () => {
  const a = await app.createAccount("feed ai");
  const rules = { match: "all", rules: [{ field: "ai.useful", op: "isTrue" }] };
  const run = await app.run(chain("feed ai", a.id, [start, { id: "feed", type: "feedPosts", params: { limit: 10 } }, { id: "ai", type: "aiPrompt", params: { prompt: 'Is this a useful post? Useful means it shares "lessons".', outputFields: [{ name: "useful", type: "boolean", description: "worth a comment" }], outputKey: "ai" } }, { id: "check", type: "condition", params: { rules } }, { id: "comment", from: "true", type: "comment", params: { text: "Thanks for writing this up, {{authorFirstName}}.", perDay: 15 } }]));
  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(steps(run).check.counts, { true: 2, false: 1 });
  assert.deepEqual(app.actions({ accountId: a.id, action: "comment" }).map((x) => [x.target, x.text]), [[postUrn(3), "Thanks for writing this up, Jo."], [postUrn(5), "Thanks for writing this up, Lee."]]);
});
