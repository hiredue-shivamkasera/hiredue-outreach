const test = require("node:test");
const assert = require("node:assert/strict");
const { templates } = require("../electron/templates.cjs");
const { catalog, describeCatalog } = require("../electron/nodes.cjs");
const { validate } = require("../electron/domain/graph.cjs");

// The starter workflows are the first thing a person runs; a catalog change that breaks one should fail here, not in front of them.
for (const t of templates) {
  test(`starter workflow "${t.name}" is valid against the catalog`, () => {
    assert.deepEqual(validate(t, catalog), []);
  });
}

// Steps whose required input is always the person's own (their API, their links, their words) are exempt; a fresh one is meant to show as unfinished.
const NEEDS_OWN_INPUT = new Set(["filter", "pollApi", "urlList"]);

test("every step's settings have defaults that pass validation on a fresh node", () => {
  for (const def of Object.values(catalog)) {
    const params = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
    const missing = def.params.filter((p) => p.required && (params[p.key] === undefined || String(params[p.key]).trim() === "")).map((p) => p.key);
    if (!NEEDS_OWN_INPUT.has(def.type)) assert.deepEqual(missing, [], `${def.type} has a required setting with no default`);
  }
});

test("the catalog sent to the editor carries no run functions", () => {
  assert.ok(describeCatalog().every((d) => !("run" in d) && d.type && d.label));
});

// Electron's IPC throws on a function anywhere in the payload, which would leave the editor with an empty palette.
test("the catalog sent to the editor survives structured cloning", () => {
  assert.doesNotThrow(() => structuredClone(describeCatalog()));
});

// Seeding is keyed; a duplicated or missing key would either never seed a workflow or seed it twice.
test("every built-in workflow has its own key", () => {
  const keys = templates.map((t) => t.key);
  assert.ok(keys.every((k) => typeof k === "string" && k.length > 0));
  assert.equal(new Set(keys).size, keys.length);
});
