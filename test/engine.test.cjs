const test = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../electron/domain/engine.cjs");

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const edge = (source, target, sourceHandle = "out") => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });

function catalogWith(overrides = {}) {
  return {
    start: { type: "start", input: null, outputs: [{ handle: "out", kind: "trigger" }], params: [], run: async () => ({ out: [{}] }) },
    people: { type: "people", input: "trigger", outputs: [{ handle: "out", kind: "person" }], params: [], run: async () => ({ out: [{ name: "Asha" }, { name: "Ravi" }, { name: "Meera" }] }) },
    split: {
      type: "split", input: "any", outputs: [{ handle: "pass", kind: "same" }, { handle: "fail", kind: "same" }], params: [],
      run: async (items) => ({ pass: items.filter((i) => i.name !== "Ravi"), fail: items.filter((i) => i.name === "Ravi") }),
    },
    collect: { type: "collect", input: "person", outputs: [{ handle: "out", kind: "person" }], params: [], run: async (items) => ({ out: items }) },
    ...overrides,
  };
}

function branchingFlow() {
  return {
    nodes: [node("s", "start"), node("p", "people"), node("x", "split"), node("yes", "collect"), node("no", "collect")],
    edges: [edge("s", "p"), edge("p", "x"), edge("x", "yes", "pass"), edge("x", "no", "fail")],
  };
}

test("items flow down the branch their handle names", async () => {
  const result = await run(branchingFlow(), { catalog: catalogWith() });
  assert.equal(result.status, "finished");
  assert.deepEqual(result.outputs.yes.out.map((i) => i.name), ["Asha", "Meera"]);
  assert.deepEqual(result.outputs.no.out.map((i) => i.name), ["Ravi"]);
});

// Without this a qualify node with nobody passing would still fire the connect node with an empty list and log it as a run.
test("a node whose inputs are all empty is skipped, not run", async () => {
  const calls = [];
  const catalog = catalogWith({ split: { ...catalogWith().split, run: async (items) => ({ pass: items, fail: [] }) } });
  catalog.collect = { ...catalog.collect, run: async (items, _p, ctx) => { calls.push(ctx.nodeId); return { out: items }; } };
  const events = [];
  await run(branchingFlow(), { catalog, emit: (e) => events.push(e) });
  assert.deepEqual(calls, ["yes"]);
  assert.ok(events.some((e) => e.type === "node.skipped" && e.nodeId === "no"));
});

test("a node fed by two edges receives both lists", async () => {
  const wf = branchingFlow();
  wf.nodes.push(node("all", "collect"));
  wf.edges.push(edge("x", "all", "pass"), edge("x", "all", "fail"));
  const result = await run(wf, { catalog: catalogWith() });
  assert.equal(result.outputs.all.out.length, 3);
});

// A node that throws means the account is in an unknown state (logged out, limit hit), so nothing downstream may act on it.
test("a node that throws fails the run and nothing after it runs", async () => {
  const catalog = catalogWith({ split: { ...catalogWith().split, run: async () => { throw new Error("logged out"); } } });
  const ran = [];
  catalog.collect = { ...catalog.collect, run: async (items, _p, ctx) => { ran.push(ctx.nodeId); return { out: items }; } };
  const result = await run(branchingFlow(), { catalog });
  assert.equal(result.status, "failed");
  assert.equal(result.failedNodeId, "x");
  assert.match(result.error, /logged out/);
  assert.deepEqual(ran, []);
});

test("a stop request between nodes ends the run as stopped", async () => {
  let stop = false;
  const catalog = catalogWith({ people: { ...catalogWith().people, run: async () => { stop = true; return { out: [{ name: "Asha" }] }; } } });
  const result = await run(branchingFlow(), { catalog, shouldStop: () => stop });
  assert.equal(result.status, "stopped");
  assert.equal(result.outputs.x, undefined);
});

test("an invalid workflow fails before any node runs", async () => {
  let ran = false;
  const catalog = catalogWith({ start: { ...catalogWith().start, run: async () => { ran = true; return { out: [{}] }; } } });
  const wf = branchingFlow();
  wf.edges.push(edge("yes", "x"));
  const result = await run(wf, { catalog });
  assert.equal(result.status, "failed");
  assert.equal(ran, false);
});

test("each node gets its own params and a context naming it", async () => {
  const seen = {};
  const catalog = catalogWith({ people: { ...catalogWith().people, run: async (_i, params, ctx) => { seen.params = params; seen.nodeId = ctx.nodeId; seen.shared = ctx.shared; return { out: [] }; } } });
  const wf = branchingFlow();
  wf.nodes[1].params = { keywords: "founder" };
  await run(wf, { catalog, ctx: { shared: 42 } });
  assert.deepEqual(seen, { params: { keywords: "founder" }, nodeId: "p", shared: 42 });
});

test("a node returning a handle it does not declare fails the run", async () => {
  const catalog = catalogWith({ people: { ...catalogWith().people, run: async () => ({ elsewhere: [] }) } });
  const result = await run(branchingFlow(), { catalog });
  assert.equal(result.status, "failed");
  assert.match(result.error, /elsewhere/);
});

function twoTriggerFlow(log) {
  const catalog = catalogWith({
    start: { ...catalogWith().start, run: async (_i, _p, ctx) => { log.push(`start:${ctx.nodeId}`); return { out: [{ kind: "trigger" }] }; } },
    people: { ...catalogWith().people, run: async (items) => ({ out: items.map((_, i) => ({ name: `p${i}` })) }) },
  });
  const wf = { nodes: [node("a", "start"), node("b", "start"), node("p", "people")], edges: [edge("a", "p"), edge("b", "p")] };
  return { catalog, wf };
}

// A schedule firing must not also fire the workflow's other triggers, or a 9am schedule would also poll the API and run the manual branch.
test("when a trigger is named, only that trigger fires", async () => {
  const log = [];
  const { catalog, wf } = twoTriggerFlow(log);
  const events = [];
  await run(wf, { catalog, firedBy: "b", emit: (e) => events.push(e) });
  assert.deepEqual(log, ["start:b"]);
  assert.ok(events.some((e) => e.type === "node.skipped" && e.nodeId === "a"));
});

test("a manual run fires every trigger", async () => {
  const log = [];
  const { catalog, wf } = twoTriggerFlow(log);
  await run(wf, { catalog });
  assert.deepEqual(log.sort(), ["start:a", "start:b"]);
});

test("a named trigger that is not in the workflow fails the run", async () => {
  const { catalog, wf } = twoTriggerFlow([]);
  const result = await run(wf, { catalog, firedBy: "zzz" });
  assert.equal(result.status, "failed");
});

test("a stop request during the last step still ends the run as stopped", async () => {
  let stop = false;
  const catalog = catalogWith();
  catalog.collect = { ...catalog.collect, run: async (items) => { stop = true; return { out: items }; } };
  const wf = { nodes: [node("s", "start"), node("p", "people"), node("c", "collect")], edges: [edge("s", "p"), edge("p", "c")] };
  const result = await run(wf, { catalog, shouldStop: () => stop });
  assert.equal(result.status, "stopped");
});
