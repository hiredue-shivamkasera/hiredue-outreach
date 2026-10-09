const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../electron/domain/runSummary.cjs");

const nodes = [{ id: "s", type: "start" }, { id: "p", type: "searchPosts" }, { id: "q", type: "qualify" }, { id: "k", type: "connect" }, { id: "m", type: "message" }];
const events = [
  { type: "node.started", nodeId: "s", inputCount: 0, at: 1000 },
  { type: "node.finished", nodeId: "s", counts: { out: 1 }, at: 1001 },
  { type: "node.started", nodeId: "p", inputCount: 1, at: 1001 },
  { type: "log", nodeId: "p", message: "Found 10 posts", at: 1500 },
  { type: "node.finished", nodeId: "p", counts: { out: 10 }, at: 9001 },
  { type: "node.started", nodeId: "q", inputCount: 10, at: 9001 },
  { type: "item.failed", nodeId: "q", message: "x: timeout", at: 9500 },
  { type: "node.finished", nodeId: "q", counts: { pass: 3, fail: 6 }, at: 12001 },
  { type: "node.started", nodeId: "k", inputCount: 3, at: 12001 },
  { type: "node.failed", nodeId: "k", message: "logged out", at: 13001 },
  { type: "node.skipped", nodeId: "m", at: 13002 },
];

test("steps come out in the order they ran, with counts, errors and time taken", () => {
  const { steps } = summarize(events, nodes);
  assert.deepEqual(steps.map((s) => s.nodeId), ["s", "p", "q", "k", "m"]);
  assert.deepEqual(steps[2], { nodeId: "q", type: "qualify", state: "done", input: 10, counts: { pass: 3, fail: 6 }, failedItems: 1, ms: 3000, error: null });
  assert.equal(steps[3].state, "failed");
  assert.equal(steps[3].error, "logged out");
  assert.equal(steps[4].state, "skipped");
});

test("the run's error count adds up failed items and failed steps", () => {
  assert.equal(summarize(events, nodes).errors, 2);
});

// A step deleted from the workflow after the run still shows, so old history never loses rows.
test("a step missing from the workflow keeps its row with an unknown type", () => {
  const { steps } = summarize(events, nodes.filter((n) => n.id !== "p"));
  assert.equal(steps[1].type, null);
});

test("a step that started and never finished reads as running", () => {
  const { steps } = summarize(events.slice(0, 3), nodes);
  assert.equal(steps[1].state, "running");
});
