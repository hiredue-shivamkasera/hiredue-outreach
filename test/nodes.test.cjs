const test = require("node:test");
const assert = require("node:assert/strict");
const { catalog } = require("../electron/nodes.cjs");
const { NotLoggedIn, InviteLimitReached } = require("../electron/adapters/linkedin.adapter.cjs");

function fakeStore({ sentToday = 0, done = [] } = {}) {
  const recorded = [];
  return {
    recorded,
    actions: {
      countSince: () => sentToday + recorded.filter((r) => r.status === "sent").length,
      alreadyDone: (_a, url) => done.includes(url),
      record: (r) => recorded.push(r),
    },
  };
}

function ctxWith(overrides) {
  const events = [];
  return { events, accountId: "acc", runId: "run", emit: (e) => events.push(e), shouldStop: () => false, linkedin: { pause: async () => {} }, ...overrides };
}

const person = (n) => ({ kind: "person", name: `Person ${n}`, profileUrl: `https://www.linkedin.com/in/p${n}/` });

test("connect stops sending once the daily allowance is spent", async () => {
  const sent = [];
  const ctx = ctxWith({ store: fakeStore({ sentToday: 18 }), linkedin: { pause: async () => {}, connect: async (p) => { sent.push(p.name); return { status: "sent" }; } } });
  const { out } = await catalog.connect.run([person(1), person(2), person(3)], { note: "", perDay: 20, perWeek: 100 }, ctx);
  assert.deepEqual(sent, ["Person 1", "Person 2"]);
  assert.equal(out.length, 2);
});

// The ledger spans every workflow on the account, so the same commenter found by two flows is invited once.
test("connect skips anyone the ledger says was already invited", async () => {
  const sent = [];
  const ctx = ctxWith({ store: fakeStore({ done: [person(1).profileUrl] }), linkedin: { pause: async () => {}, connect: async (p) => { sent.push(p.name); return { status: "sent" }; } } });
  await catalog.connect.run([person(1), person(2)], { note: "", perDay: 20, perWeek: 100 }, ctx);
  assert.deepEqual(sent, ["Person 2"]);
});

test("connect fills the note template from the person", async () => {
  let note;
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, connect: async (_p, n) => { note = n; return { status: "sent" }; } } });
  await catalog.connect.run([{ ...person(1), name: "Asha Rao" }], { note: "Hi {{firstName}}!", perDay: 20, perWeek: 100 }, ctx);
  assert.equal(note, "Hi Asha!");
});

// An unverified invite may not have gone through, so it must not use up allowance or flow on as invited.
test("only invites LinkedIn confirmed are emitted and counted", async () => {
  const store = fakeStore();
  const statuses = ["sent", "unverified", "pending"];
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, connect: async () => ({ status: statuses.shift() }) } });
  const { out } = await catalog.connect.run([person(1), person(2), person(3)], { note: "", perDay: 20, perWeek: 100 }, ctx);
  assert.deepEqual(out.map((p) => p.name), ["Person 1"]);
  assert.deepEqual(store.recorded.map((r) => r.status), ["sent", "unverified", "pending"]);
});

test("LinkedIn's weekly limit ends the connect step without failing the run", async () => {
  let calls = 0;
  const store = fakeStore();
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, connect: async () => { calls++; if (calls === 2) throw new InviteLimitReached("weekly limit"); return { status: "sent" }; } } });
  const { out } = await catalog.connect.run([person(1), person(2), person(3)], { note: "", perDay: 20, perWeek: 100 }, ctx);
  assert.equal(calls, 2);
  assert.equal(out.length, 1);
  assert.equal(store.recorded[1].status, "limit");
});

test("a note over LinkedIn's 300 characters fails that person instead of being cut", async () => {
  let called = false;
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, connect: async () => { called = true; return { status: "sent" }; } } });
  await catalog.connect.run([person(1)], { note: "x".repeat(301), perDay: 20, perWeek: 100 }, ctx);
  assert.equal(called, false);
  assert.ok(ctx.events.some((e) => e.type === "item.failed" && /301/.test(e.message)));
});

test("a lost session fails the whole step", async () => {
  const ctx = ctxWith({ linkedin: { pause: async () => {}, readProfile: async () => { throw new NotLoggedIn("logged out"); } } });
  await assert.rejects(catalog.visitProfile.run([person(1), person(2)], {}, ctx), NotLoggedIn);
});

test("one bad profile costs only that person", async () => {
  let n = 0;
  const ctx = ctxWith({ linkedin: { pause: async () => {}, readProfile: async () => { if (++n === 2) throw new Error("timeout"); return { headline: "CEO" }; } } });
  const { out } = await catalog.visitProfile.run([person(1), person(2), person(3)], {}, ctx);
  assert.deepEqual(out.map((p) => p.name), ["Person 1", "Person 3"]);
});

// A missing API key fails every item the same way; stopping after three saves a hundred identical errors.
test("three failures on the first three items stop the step", async () => {
  let calls = 0;
  const ctx = ctxWith({ llm: { chatJson: async () => { calls++; return { ok: false, error: "No LLM API key set" }; } } });
  await assert.rejects(catalog.qualify.run([1, 2, 3, 4, 5].map(person), { prompt: "x", minScore: 70 }, ctx), /first three/);
  assert.equal(calls, 3);
});

test("qualify routes by verdict and keeps the reason on the item", async () => {
  const answers = [{ qualified: true, score: 90, reason: "agency owner" }, { qualified: false, score: 10, reason: "student" }];
  const ctx = ctxWith({ llm: { chatJson: async () => ({ ok: true, value: answers.shift() }) } });
  const { pass, fail } = await catalog.qualify.run([person(1), person(2)], { prompt: "x", minScore: 70 }, ctx);
  assert.equal(pass[0].evaluation.reason, "agency owner");
  assert.equal(fail[0].name, "Person 2");
});

test("message skips people already messaged from this account", async () => {
  const sent = [];
  const ctx = ctxWith({ store: fakeStore({ done: [person(2).profileUrl] }), linkedin: { pause: async () => {}, sendMessage: async (p) => { sent.push(p.name); return { status: "sent" }; } } });
  await catalog.message.run([person(1), person(2)], { text: "Hi {{firstName}}", perDay: 30 }, ctx);
  assert.deepEqual(sent, ["Person 1"]);
});

test("post commenters keeps only matching comments and drops repeat people across posts", async () => {
  const comments = { a: [{ name: "Asha Rao", profileUrl: "u1", comment: "Interested!" }, { name: "Ravi", profileUrl: "u2", comment: "congrats" }], b: [{ name: "Asha Rao", profileUrl: "u1", comment: "interested" }] };
  const ctx = ctxWith({ linkedin: { pause: async () => {}, commentersOf: async (post) => ({ people: comments[post.id], note: null }) } });
  const { out } = await catalog.postCommenters.run([{ id: "a", authorName: "A" }, { id: "b", authorName: "B" }], { matchWords: "interested", limitPerPost: 50 }, ctx);
  assert.deepEqual(out.map((p) => p.firstName), ["Asha"]);
});

const post = (n) => ({ kind: "post", authorName: `Author ${n}`, postUrn: `urn:li:activity:738123456789012345${n}`, postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/` });

// A post found by two different searches is the same post; the ledger key must be the post, not the search that found it.
test("like skips posts this account already reacted to, keyed by the post", async () => {
  const liked = [];
  const ctx = ctxWith({ store: fakeStore({ done: [post(1).postUrn] }), linkedin: { pause: async () => {}, like: async (p, r) => { liked.push([p.authorName, r]); return { status: "sent" }; } } });
  const { out } = await catalog.like.run([post(1), post(2)], { reaction: "insightful", perDay: 50 }, ctx);
  assert.deepEqual(liked, [["Author 2", "insightful"]]);
  assert.equal(out.length, 1);
});

test("a post already liked by hand is recorded as done and not passed on", async () => {
  const store = fakeStore();
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, like: async () => ({ status: "already" }) } });
  const { out } = await catalog.like.run([post(1)], { reaction: "like", perDay: 50 }, ctx);
  assert.equal(out.length, 0);
  assert.equal(store.recorded[0].status, "already");
});

test("comment fills the template from the post and stops at its allowance", async () => {
  const said = [];
  const ctx = ctxWith({ store: fakeStore({ sentToday: 14 }), linkedin: { pause: async () => {}, comment: async (_p, t) => { said.push(t); return { status: "sent" }; } } });
  const { out } = await catalog.comment.run([{ ...post(1), draft: "Great point" }, post(2)], { text: "{{draft}}, {{authorFirstName}}", perDay: 15 }, ctx);
  assert.deepEqual(said, ["Great point, Author"]);
  assert.equal(out[0].commented, "Great point, Author");
});

test("an empty comment fails that post instead of posting nothing", async () => {
  let called = false;
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, comment: async () => { called = true; return { status: "sent" }; } } });
  await catalog.comment.run([post(1)], { text: "{{draft}}", perDay: 15 }, ctx);
  assert.equal(called, false);
});

test("follow acts on a page link, a profile, or a post's author", async () => {
  const store = fakeStore();
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, follow: async () => ({ status: "sent" }) } });
  await catalog.follow.run([{ kind: "page", pageUrl: "https://www.linkedin.com/company/acme/" }, { kind: "post", authorUrl: "https://www.linkedin.com/in/asha/" }], { perDay: 30 }, ctx);
  assert.deepEqual(store.recorded.map((r) => r.target), ["https://www.linkedin.com/company/acme/", "https://www.linkedin.com/in/asha/"]);
});

test("repost passes the rendered thoughts, or an empty string when the setting is blank", async () => {
  const got = [];
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, repost: async (_p, t) => { got.push(t); return { status: "sent" }; } } });
  await catalog.repost.run([{ ...post(1), draft: "Worth a read" }], { thoughts: "{{draft}}", perDay: 5 }, ctx);
  await catalog.repost.run([post(2)], { thoughts: "", perDay: 5 }, ctx);
  assert.deepEqual(got, ["Worth a read", ""]);
});

// Quietly falling back to a plain repost would publish something other than what the workflow asked for.
test("repost with thoughts that need a missing draft fails that post instead of reposting bare", async () => {
  let called = false;
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, repost: async () => { called = true; return { status: "sent" }; } } });
  await catalog.repost.run([post(2)], { thoughts: "{{draft}}", perDay: 5 }, ctx);
  assert.equal(called, false);
  assert.ok(ctx.events.some((e) => e.type === "item.failed" && /draft/.test(e.message)));
});

test("the URL list keeps links of the chosen kind and reports the rest", async () => {
  const ctx = ctxWith({});
  const { out } = await catalog.urlList.run([], { urls: "https://www.linkedin.com/company/acme/\nlinkedin.com/company/acme\nhttps://www.linkedin.com/in/asha/\n\nhttps://www.linkedin.com/school/iitb/", itemKind: "page" }, ctx);
  assert.deepEqual(out.map((i) => i.pageUrl), ["https://www.linkedin.com/company/acme/", "https://www.linkedin.com/school/iitb/"]);
  assert.equal(ctx.events.filter((e) => e.type === "item.failed").length, 1);
});

// The scheduler already fetched and marked these records seen; fetching again would find nothing new and the run would do nothing.
test("a poll trigger that fired uses the records it was handed", async () => {
  let polled = false;
  const items = [{ kind: "person", profileUrl: "u1" }];
  const { out } = await catalog.pollApi.run([], {}, ctxWith({ nodeId: "poll", trigger: { firedBy: "poll", items }, pollNow: async () => { polled = true; return { items: [] }; } }));
  assert.equal(polled, false);
  assert.deepEqual(out, items);
});

test("pressing Run on a poll trigger fetches now", async () => {
  const items = [{ kind: "person", profileUrl: "u2" }];
  const { out } = await catalog.pollApi.run([], {}, ctxWith({ nodeId: "poll", trigger: { firedBy: null }, pollNow: async () => ({ items, rejected: 0, total: 3 }) }));
  assert.deepEqual(out, items);
});

const fitFields = [{ name: "fit_score", type: "number", description: "0-100" }, { name: "is_decision_maker", type: "boolean", description: "takes vendor calls" }];

test("AI prompt fills the template from the item and sends the item and the output format", async () => {
  let sent;
  const ctx = ctxWith({ llm: { chatJson: async (req) => { sent = req; return { ok: true, value: { fit_score: 80, is_decision_maker: true } }; } } });
  await catalog.aiPrompt.run([{ ...person(1), name: "Asha Rao", headline: "Founder at Acme" }], { prompt: "Is {{firstName}} a buyer?", outputFields: fitFields, outputKey: "ai" }, ctx);
  const all = `${sent.system}\n${sent.user}`;
  assert.match(sent.user, /Is Asha a buyer\?/);
  assert.match(sent.user, /Founder at Acme/);
  assert.match(all, /"fit_score"/);
  assert.match(all, /"is_decision_maker"/);
});

test("AI prompt puts the checked answer on the item under its output key", async () => {
  const ctx = ctxWith({ llm: { chatJson: async () => ({ ok: true, value: { fit_score: "75", is_decision_maker: false, chatter: "x" } }) } });
  const { out } = await catalog.aiPrompt.run([person(1)], { prompt: "x", outputFields: fitFields, outputKey: "fit" }, ctx);
  assert.deepEqual(out[0].fit, { fit_score: 75, is_decision_maker: false });
  assert.equal(out[0].name, "Person 1");
});

// An answer missing a field must cost that item, not flow on with a blank the Condition step would read as a real "no".
test("AI prompt fails an item whose answer does not match the fields", async () => {
  const answers = [{ fit_score: 90, is_decision_maker: true }, { fit_score: 90 }, { fit_score: 40, is_decision_maker: false }];
  const ctx = ctxWith({ llm: { chatJson: async () => ({ ok: true, value: answers.shift() }) } });
  const { out } = await catalog.aiPrompt.run([person(1), person(2), person(3)], { prompt: "x", outputFields: fitFields, outputKey: "ai" }, ctx);
  assert.deepEqual(out.map((p) => p.name), ["Person 1", "Person 3"]);
  assert.ok(ctx.events.some((e) => e.type === "item.failed" && /is_decision_maker/.test(e.message)));
});

test("AI prompt stops when the first three answers are unreadable", async () => {
  let calls = 0;
  const ctx = ctxWith({ llm: { chatJson: async () => { calls++; return { ok: true, value: { wrong: 1 } }; } } });
  await assert.rejects(catalog.aiPrompt.run([1, 2, 3, 4].map(person), { prompt: "x", outputFields: fitFields, outputKey: "ai" }, ctx), /first three/);
  assert.equal(calls, 3);
});

test("condition routes items by its rules", async () => {
  const items = [{ ...person(1), ai: { fit_score: 82, is_decision_maker: true } }, { ...person(2), ai: { fit_score: 90, is_decision_maker: false } }, person(3)];
  const rules = { match: "all", rules: [{ field: "ai.fit_score", op: "atLeast", value: "70" }, { field: "ai.is_decision_maker", op: "isTrue" }] };
  const res = await catalog.condition.run(items, { rules }, ctxWith({}));
  assert.deepEqual(res.true.map((p) => p.name), ["Person 1"]);
  assert.deepEqual(res.false.map((p) => p.name), ["Person 2", "Person 3"]);
});

test("condition and AI prompt report bad settings through their validate hooks", () => {
  assert.match(catalog.condition.validate({ rules: { match: "all", rules: [{ field: "x", op: "roughly" }] } }).join(), /roughly/);
  assert.deepEqual(catalog.condition.validate({ rules: catalog.condition.params[0].default }), []);
  assert.match(catalog.aiPrompt.validate({ outputFields: [{ name: "a b", type: "text" }], outputKey: "ai" }).join(), /a b/);
  assert.match(catalog.aiPrompt.validate({ outputFields: fitFields, outputKey: "ai.x" }).join(), /ai\.x/);
  assert.match(catalog.aiPrompt.validate({ outputFields: fitFields, outputKey: "name" }).join(), /name/);
});

test("feed posts hands on what the feed reader found", async () => {
  let asked;
  const posts = [{ kind: "post", authorName: "A", postUrn: "urn:li:activity:1", text: "hello" }];
  const { out } = await catalog.feedPosts.run([], { limit: 7 }, ctxWith({ linkedin: { readFeed: async (o) => { asked = o; return posts; } } }));
  assert.equal(asked.limit, 7);
  assert.deepEqual(out, posts);
});

const GROUP_ORDER = ["Triggers", "Search", "Feed", "Posts", "Profile", "Messaging", "CRM", "AI", "Logic"];

// The palette draws groups in the order the catalog lists them, so a step out of order splits its group in two.
test("every step has a known group and an icon, and the catalog lists them in group order", () => {
  const { describeCatalog } = require("../electron/nodes.cjs");
  const list = describeCatalog();
  for (const d of list) {
    assert.ok(GROUP_ORDER.includes(d.group), `${d.type} has group ${d.group}`);
    assert.match(d.icon || "", /^[A-Z][A-Za-z0-9]+$/, `${d.type} has no icon`);
  }
  const idx = list.map((d) => GROUP_ORDER.indexOf(d.group));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});
