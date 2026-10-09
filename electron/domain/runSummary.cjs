// Folds a run's events into one row per step: what went in, what came out of each handle, how many items failed, how long it took. Pure; stored with the run so history lists stay fast.

function summarize(events, nodes = []) {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const steps = new Map();
  let errors = 0;
  const step = (id) => {
    if (!steps.has(id)) steps.set(id, { nodeId: id, type: typeOf.get(id) ?? null, state: null, input: null, counts: null, failedItems: 0, ms: null, error: null, startedAt: null });
    return steps.get(id);
  };
  for (const e of events) {
    if (!e.nodeId) continue;
    const s = step(e.nodeId);
    if (e.type === "node.started") Object.assign(s, { state: "running", input: e.inputCount, startedAt: e.at });
    else if (e.type === "node.finished") Object.assign(s, { state: "done", counts: e.counts, ms: s.startedAt != null ? e.at - s.startedAt : null });
    else if (e.type === "node.failed") { Object.assign(s, { state: "failed", error: e.message, ms: s.startedAt != null ? e.at - s.startedAt : null }); errors++; }
    else if (e.type === "node.skipped") s.state = "skipped";
    else if (e.type === "item.failed") { s.failedItems++; errors++; }
  }
  return { steps: [...steps.values()].map(({ startedAt, ...rest }) => rest), errors };
}

module.exports = { summarize };
