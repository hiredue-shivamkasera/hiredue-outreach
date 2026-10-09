// The rules a workflow must satisfy before it may run: one start, no loops, every edge carrying the kind of item its target accepts. Pure: no page, no network, no database.

// Kahn's algorithm; returns null when a loop leaves nodes that never reach zero incoming edges.
function order(workflow) {
  const incoming = new Map(workflow.nodes.map((n) => [n.id, 0]));
  for (const e of workflow.edges) if (incoming.has(e.target)) incoming.set(e.target, incoming.get(e.target) + 1);
  const ready = workflow.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  const sorted = [];
  while (ready.length) {
    const id = ready.shift();
    sorted.push(id);
    for (const e of workflow.edges.filter((x) => x.source === id)) {
      if (!incoming.has(e.target)) continue;
      incoming.set(e.target, incoming.get(e.target) - 1);
      if (incoming.get(e.target) === 0) ready.push(e.target);
    }
  }
  return sorted.length === workflow.nodes.length ? sorted : null;
}

// A "same" output carries whatever kind arrived, so kinds are resolved in execution order.
function resolveKinds(workflow, catalog, sorted) {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const inputKind = new Map();
  const outputKind = (nodeId, handle) => {
    const def = catalog[byId.get(nodeId)?.type];
    const out = def?.outputs.find((o) => o.handle === handle);
    if (!out) return undefined;
    if (out.kind === "same") return inputKind.get(nodeId);
    if (out.kind.startsWith("param:")) return byId.get(nodeId).params?.[out.kind.slice(6)];
    return out.kind;
  };
  const problems = [];
  for (const id of sorted) {
    const kinds = new Set(workflow.edges.filter((e) => e.target === id).map((e) => outputKind(e.source, e.sourceHandle)).filter(Boolean));
    if (kinds.size > 1) problems.push({ nodeId: id, message: `This step mixes ${[...kinds].join(" and ")} in one input` });
    inputKind.set(id, [...kinds][0]);
  }
  return { inputKind, problems };
}

function validate(workflow, catalog) {
  const problems = [];
  const ids = new Set(workflow.nodes.map((n) => n.id));

  for (const n of workflow.nodes) {
    const def = catalog[n.type];
    if (!def) { problems.push({ nodeId: n.id, message: `Unknown step type "${n.type}"` }); continue; }
    for (const p of def.params) {
      const value = n.params?.[p.key];
      if (p.required && (value === undefined || value === null || String(value).trim() === "")) problems.push({ nodeId: n.id, message: `${p.label || p.key} is required` });
    }
    // Structured settings (rule lists, field lists) can be non-empty and still broken, so a step may check its own.
    if (def.validate) for (const message of def.validate(n.params || {})) problems.push({ nodeId: n.id, message });
  }
  if (problems.some((p) => /Unknown step type/.test(p.message))) return problems;

  if (!workflow.nodes.some((n) => catalog[n.type].input === null)) problems.push({ message: "Add a Start step; nothing runs without one" });

  for (const e of workflow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) { problems.push({ message: `Connection ${e.id} points at a step that no longer exists` }); continue; }
    const source = workflow.nodes.find((n) => n.id === e.source);
    if (!catalog[source.type].outputs.some((o) => o.handle === e.sourceHandle)) problems.push({ nodeId: e.source, message: `Has no output called "${e.sourceHandle}"` });
  }

  for (const n of workflow.nodes) {
    if (catalog[n.type].input !== null && !workflow.edges.some((e) => e.target === n.id)) problems.push({ nodeId: n.id, message: "Input is not connected" });
  }

  const sorted = order(workflow);
  if (!sorted) { problems.push({ message: "The workflow has a loop; steps must flow one way" }); return problems; }

  const { inputKind, problems: mixed } = resolveKinds(workflow, catalog, sorted);
  problems.push(...mixed);
  for (const n of workflow.nodes) {
    const accepts = catalog[n.type].input;
    const gets = inputKind.get(n.id);
    const list = Array.isArray(accepts) ? accepts : [accepts];
    if (accepts && accepts !== "any" && gets && !list.includes(gets)) problems.push({ nodeId: n.id, message: `Step expects ${list.join(" or ")} items but gets ${gets} items` });
  }
  return problems;
}

module.exports = { validate, order };
