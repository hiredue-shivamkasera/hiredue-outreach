const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, order } = require("../electron/domain/graph.cjs");

const catalog = {
  start: { type: "start", input: null, outputs: [{ handle: "out", kind: "trigger" }], params: [] },
  searchPosts: { type: "searchPosts", input: "trigger", outputs: [{ handle: "out", kind: "post" }], params: [{ key: "keywords", required: true }] },
  commenters: { type: "commenters", input: "post", outputs: [{ handle: "out", kind: "person" }], params: [] },
  qualify: { type: "qualify", input: "any", outputs: [{ handle: "pass", kind: "same" }, { handle: "fail", kind: "same" }], params: [{ key: "prompt", required: true }] },
  connect: { type: "connect", input: "person", outputs: [{ handle: "out", kind: "person" }], params: [] },
};

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const edge = (source, target, sourceHandle = "out") => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });

function hiringFlow() {
  return {
    nodes: [node("s", "start"), node("p", "searchPosts", { keywords: "hiring" }), node("c", "commenters"), node("q", "qualify", { prompt: "is a founder" }), node("k", "connect")],
    edges: [edge("s", "p"), edge("p", "c"), edge("c", "q"), edge("q", "k", "pass")],
  };
}

test("a well-formed hiring-post flow has no problems", () => {
  assert.deepEqual(validate(hiringFlow(), catalog), []);
});

// The editor lets you draw any edge, so the kind check is the only thing stopping a post list reaching a node that sends invites to people.
test("an edge that feeds posts into a person-only node is rejected", () => {
  const wf = hiringFlow();
  wf.edges = [edge("s", "p"), edge("p", "k")];
  wf.nodes = wf.nodes.filter((n) => n.id !== "c" && n.id !== "q");
  const problems = validate(wf, catalog);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].nodeId, "k");
  assert.match(problems[0].message, /expects person.*gets post/);
});

// qualify passes through whatever it is given, so connect after qualify is only valid when qualify was fed people.
test("a pass-through node takes the kind of whatever feeds it", () => {
  const wf = hiringFlow();
  wf.edges = [edge("s", "p"), edge("p", "q"), edge("q", "k", "pass")];
  wf.nodes = wf.nodes.filter((n) => n.id !== "c");
  const problems = validate(wf, catalog);
  assert.deepEqual(problems.map((p) => p.nodeId), ["k"]);
});

test("a node fed two different kinds is rejected", () => {
  const wf = hiringFlow();
  wf.edges.push(edge("p", "q"));
  assert.ok(validate(wf, catalog).some((p) => p.nodeId === "q" && /mixes/.test(p.message)));
});

test("a cycle is rejected and has no execution order", () => {
  const wf = hiringFlow();
  wf.edges.push(edge("k", "c"));
  assert.ok(validate(wf, catalog).some((p) => /loop/.test(p.message)));
  assert.equal(order(wf), null);
});

test("a flow with no start node is rejected", () => {
  const wf = hiringFlow();
  wf.nodes = wf.nodes.filter((n) => n.id !== "s");
  wf.edges = wf.edges.filter((e) => e.source !== "s");
  assert.ok(validate(wf, catalog).some((p) => /Start/.test(p.message)));
});

test("a node with an input but nothing wired into it is reported", () => {
  const wf = hiringFlow();
  wf.edges = wf.edges.filter((e) => e.target !== "k");
  assert.ok(validate(wf, catalog).some((p) => p.nodeId === "k" && /not connected/.test(p.message)));
});

test("a blank required setting is reported against its node", () => {
  const wf = hiringFlow();
  wf.nodes[1].params.keywords = "  ";
  assert.ok(validate(wf, catalog).some((p) => p.nodeId === "p" && /Keywords|keywords/.test(p.message)));
});

test("an edge from a handle the node does not have is rejected", () => {
  const wf = hiringFlow();
  wf.edges[3] = edge("q", "k", "maybe");
  assert.ok(validate(wf, catalog).some((p) => /maybe/.test(p.message)));
});

test("an unknown node type is rejected rather than skipped", () => {
  const wf = hiringFlow();
  wf.nodes.push(node("x", "teleport"));
  assert.ok(validate(wf, catalog).some((p) => p.nodeId === "x"));
});

test("order puts every node after everything that feeds it", () => {
  const ids = order(hiringFlow());
  assert.deepEqual(ids, ["s", "p", "c", "q", "k"]);
});

test("a step that accepts a list of kinds takes any of them and rejects the rest", () => {
  const cat = { ...catalog, like: { type: "like", input: ["post", "page"], outputs: [{ handle: "out", kind: "post" }], params: [] } };
  const ok = { nodes: [node("s", "start"), node("p", "searchPosts", { keywords: "x" }), node("l", "like")], edges: [edge("s", "p"), edge("p", "l")] };
  assert.deepEqual(validate(ok, cat), []);
  const bad = { nodes: [...hiringFlow().nodes, node("l", "like")], edges: [...hiringFlow().edges, edge("c", "l")] };
  assert.ok(validate(bad, cat).some((p) => p.nodeId === "l" && /post or page/.test(p.message)));
});

// The URL list and the API poller emit whatever kind their settings say, so a connect after them is valid only when that setting is person.
test("an output kind can come from one of the step's settings", () => {
  const cat = { ...catalog, urls: { type: "urls", input: "trigger", outputs: [{ handle: "out", kind: "param:itemKind" }], params: [] } };
  const wf = (itemKind) => ({ nodes: [node("s", "start"), node("u", "urls", { itemKind }), node("k", "connect")], edges: [edge("s", "u"), edge("u", "k")] });
  assert.deepEqual(validate(wf("person"), cat), []);
  assert.ok(validate(wf("page"), cat).some((p) => p.nodeId === "k"));
});

// Some settings are structured (a rule list, a field list) and a non-empty value can still be broken; the step's own check must reach the editor.
test("a step's own validate hook reports problems against its node", () => {
  const cat = { ...catalog, gate: { type: "gate", input: "any", outputs: [{ handle: "true", kind: "same" }], params: [{ key: "rules" }], validate: (p) => (p.rules === "ok" ? [] : ["Rule 1 is broken"]) } };
  const wf = (rules) => ({ nodes: [node("s", "start"), node("p", "searchPosts", { keywords: "x" }), node("g", "gate", { rules })], edges: [edge("s", "p"), edge("p", "g")] });
  assert.deepEqual(validate(wf("ok"), cat), []);
  assert.deepEqual(validate(wf("bad"), cat), [{ nodeId: "g", message: "Rule 1 is broken" }]);
});
