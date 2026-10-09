const test = require("node:test");
const assert = require("node:assert/strict");
const { STAGES, advanceStage, stageFromSignals, mergeSnapshot, peopleAndPostsIn, engagementOf, parseTags } = require("../electron/domain/crm.cjs");

test("stages run new to lost in the order the pipeline moves", () => {
  assert.deepEqual(STAGES.map((s) => s.id), ["new", "invited", "connected", "messaged", "replied", "calendar_sent", "qualified", "meeting", "won", "dropped", "lost"]);
});

test("a stage moves forward on a later signal", () => {
  assert.equal(advanceStage("new", "invited"), "invited");
  assert.equal(advanceStage("invited", "replied"), "replied");
});

// A rerun that sees the invite again must not undo a reply the person already sent.
test("a stage never moves backwards on its own", () => {
  assert.equal(advanceStage("replied", "invited"), "replied");
  assert.equal(advanceStage("messaged", "connected"), "messaged");
});

// The owner sets these by hand after a conversation; a run cannot know better.
test("an automatic signal never overrides a stage set by hand", () => {
  for (const manual of ["qualified", "meeting", "won", "lost"]) assert.equal(advanceStage(manual, "replied"), manual);
});

test("an automatic signal can never put someone into a stage only a person sets", () => {
  assert.equal(advanceStage("replied", "won"), "replied");
});

test("an unknown or missing stage starts from new", () => {
  assert.equal(advanceStage(null, null), "new");
  assert.equal(advanceStage("bogus", "messaged"), "messaged");
});

test("the ledger, the degree and a reply each imply a stage, and the furthest one wins", () => {
  assert.equal(stageFromSignals({ actions: [] }), "new");
  assert.equal(stageFromSignals({ actions: [{ action: "connect", status: "sent" }] }), "invited");
  assert.equal(stageFromSignals({ actions: [{ action: "connect", status: "pending" }] }), "invited");
  assert.equal(stageFromSignals({ actions: [{ action: "connect", status: "sent" }], degree: "1st" }), "connected");
  assert.equal(stageFromSignals({ actions: [{ action: "connect", status: "connected" }] }), "connected");
  assert.equal(stageFromSignals({ actions: [{ action: "message", status: "sent" }] }), "messaged");
  assert.equal(stageFromSignals({ actions: [{ action: "followup", status: "sent" }] }), "messaged");
  assert.equal(stageFromSignals({ actions: [{ action: "message", status: "sent" }], replied: true }), "replied");
});

// An invite that may not have gone through is not proof the person was invited.
test("failed and unverified attempts imply nothing", () => {
  assert.equal(stageFromSignals({ actions: [{ action: "connect", status: "unverified" }, { action: "message", status: "failed" }, { action: "message", status: "not_connected" }] }), "new");
});

test("a newer snapshot updates the person and keeps earlier AI results it lacks", () => {
  const old = { name: "Asha Rao", headline: "Founder", degree: "2nd", data: { kind: "person", evaluation: { score: 90 }, draft: "hi" } };
  const merged = mergeSnapshot(old, { kind: "person", profileUrl: "u", name: "Asha Rao", headline: null, degree: "1st", draft: "hello again" });
  assert.equal(merged.headline, "Founder");
  assert.equal(merged.degree, "1st");
  assert.equal(merged.data.draft, "hello again");
  assert.deepEqual(merged.data.evaluation, { score: 90 });
});

test("a person seen for the first time takes the snapshot as it is", () => {
  const merged = mergeSnapshot(null, { kind: "person", profileUrl: "u", name: "Ravi", location: "Pune" });
  assert.equal(merged.name, "Ravi");
  assert.equal(merged.location, "Pune");
  assert.equal(merged.data.profileUrl, "u");
});

// Later steps carry more about the same person (profile read, AI score), so the last snapshot in execution order is the newest.
test("a run's outputs give one person per link, merged in step order, and one post per key", () => {
  const outputs = {
    search: { out: [{ kind: "person", profileUrl: "u1", name: "Asha" }, { kind: "person", profileUrl: "u2", name: "Ravi" }] },
    visit: { out: [{ kind: "person", profileUrl: "u1", name: "Asha Rao", headline: "CEO" }] },
    qualify: { pass: [{ kind: "person", profileUrl: "u1", name: "Asha Rao", headline: "CEO", evaluation: { score: 80 } }], fail: [] },
    posts: { out: [{ kind: "post", postUrn: "urn:li:activity:1", postUrl: "p1" }, { kind: "post", postUrl: "p2" }, { kind: "post" }] },
    trigger: { out: [{ kind: "trigger" }] },
  };
  const { people, posts } = peopleAndPostsIn(outputs);
  assert.deepEqual(people.map((p) => p.profileUrl), ["u1", "u2"]);
  assert.equal(people[0].headline, "CEO");
  assert.deepEqual(people[0].evaluation, { score: 80 });
  assert.deepEqual(posts.map((p) => p.postKey), ["urn:li:activity:1", "p2"]);
});

test("a post's engagement is the latest result of each action on it", () => {
  const engagement = engagementOf([{ action: "like", status: "failed", at: 1 }, { action: "like", status: "sent", at: 2 }, { action: "comment", status: "unverified", at: 3 }, { action: "follow", status: "sent", at: 4 }]);
  assert.deepEqual(engagement, { like: "sent", comment: "unverified" });
});

test("tags are trimmed, deduplicated and empty ones dropped", () => {
  assert.deepEqual(parseTags(" hot, lead ,hot,, "), ["hot", "lead"]);
  assert.deepEqual(parseTags(["a", " a", "b "]), ["a", "b"]);
  assert.deepEqual(parseTags(null), []);
});
