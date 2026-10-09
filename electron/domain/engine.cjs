// Runs a validated workflow: each step gets the items its incoming edges carry and hands its outputs on by handle. Knows nothing about LinkedIn; the steps it calls come from the catalog.

const { validate, order } = require("./graph.cjs");

// firedBy names the trigger that started this run (a schedule, an API poll); without it every trigger fires, which is what pressing Run means.
async function run(workflow, { catalog, ctx = {}, emit = () => {}, shouldStop = () => false, firedBy = null }) {
  const problems = validate(workflow, catalog);
  if (firedBy && !workflow.nodes.some((n) => n.id === firedBy && catalog[n.type]?.input === null)) problems.push({ message: `The trigger that fired (${firedBy}) is no longer in this workflow` });
  if (problems.length) return { status: "failed", error: problems.map((p) => p.message).join("; "), problems, outputs: {} };

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const outputs = {};

  for (const id of order(workflow)) {
    if (shouldStop()) return { status: "stopped", outputs };
    const n = byId.get(id);
    const def = catalog[n.type];
    const feeds = workflow.edges.filter((e) => e.target === id);
    const items = feeds.flatMap((e) => outputs[e.source]?.[e.sourceHandle] || []);

    if (def.input === null && firedBy && id !== firedBy) { emit({ type: "node.skipped", nodeId: id }); continue; }
    if (def.input !== null && items.length === 0) { emit({ type: "node.skipped", nodeId: id }); continue; }

    emit({ type: "node.started", nodeId: id, inputCount: items.length });
    try {
      const result = await def.run(items, n.params || {}, { ...ctx, nodeId: id, emit: (e) => emit({ ...e, nodeId: id }), shouldStop });
      const unknown = Object.keys(result).filter((h) => !def.outputs.some((o) => o.handle === h));
      if (unknown.length) throw new Error(`Step "${n.type}" returned an output it does not declare: ${unknown.join(", ")}`);
      outputs[id] = result;
      emit({ type: "node.finished", nodeId: id, counts: Object.fromEntries(Object.entries(result).map(([h, list]) => [h, list.length])) });
    } catch (err) {
      emit({ type: "node.failed", nodeId: id, message: err.message });
      return { status: "failed", failedNodeId: id, error: err.message, outputs };
    }
  }
  // A Stop that lands during the last step still means the run did not do everything it would have.
  return { status: shouldStop() ? "stopped" : "finished", outputs };
}

module.exports = { run };
