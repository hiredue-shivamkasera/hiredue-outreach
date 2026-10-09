const test = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler } = require("../electron/scheduler.cjs");

const T0 = new Date(2026, 9, 8, 10, 0); // a Thursday, inside working hours

function setup({ nodes, startError = null, api = { leads: [] } }) {
  const state = new Map();
  const seen = new Map();
  const starts = [];
  const key = (w, n) => `${w}/${n}`;
  const store = {
    workflows: { listActive: () => ["wf"], get: () => ({ id: "wf", accountId: "acc", nodes, edges: [] }) },
    triggers: {
      get: (w, n) => ({ nextAt: null, lastAt: null, lastError: null, lastResult: null, ...state.get(key(w, n)), seen: seen.get(key(w, n)) || [] }),
      set: (w, n, patch) => state.set(key(w, n), { ...state.get(key(w, n)), ...patch }),
      markSeen: (w, n, keys) => seen.set(key(w, n), [...(seen.get(key(w, n)) || []), ...keys]),
    },
  };
  const runner = { start: async (id, opts) => { if (startError) { const e = new Error(startError.message); e.code = startError.code; throw e; } starts.push({ id, ...opts }); return "run1"; } };
  let now = T0;
  const scheduler = createScheduler({ store, runner, fetchJson: async () => api, now: () => now, random: () => 0.5 });
  return { scheduler, starts, state: (n) => state.get(key("wf", n)) || {}, seen: (n) => seen.get(key("wf", n)) || [], setNow: (d) => { now = d; } };
}

const schedule = { id: "sch", type: "schedule", params: { everyMinutes: 60, fromHour: 9, toHour: 19, days: "everyday", jitterMinutes: 0 } };
const poll = { id: "poll", type: "pollApi", params: { url: "https://api.test/leads", itemsPath: "leads", urlField: "url", keyField: "id", itemKind: "person", everyMinutes: 30, maxItems: 25 } };

// Firing the moment a workflow is switched on would surprise someone who only meant to arm it.
test("a schedule's first tick sets its next run without firing", async () => {
  const s = setup({ nodes: [schedule] });
  await s.scheduler.tick();
  assert.equal(s.starts.length, 0);
  assert.equal(s.state("sch").nextAt, new Date(2026, 9, 8, 11, 0).getTime());
});

test("a due schedule starts a run fired by that trigger and books the next one", async () => {
  const s = setup({ nodes: [schedule] });
  await s.scheduler.tick();
  s.setNow(new Date(2026, 9, 8, 11, 1));
  await s.scheduler.tick();
  assert.deepEqual(s.starts, [{ id: "wf", firedBy: "sch" }]);
  assert.equal(s.state("sch").nextAt, new Date(2026, 9, 8, 12, 1).getTime());
});

test("a due schedule whose account is busy retries in five minutes", async () => {
  const s = setup({ nodes: [schedule], startError: { message: "busy", code: "BUSY" } });
  await s.scheduler.tick();
  s.setNow(new Date(2026, 9, 8, 11, 1));
  await s.scheduler.tick();
  assert.equal(s.state("sch").nextAt, new Date(2026, 9, 8, 11, 6).getTime());
  assert.match(s.state("sch").lastError, /busy/);
});

test("a poll is due straight away and starts a run with only the new records", async () => {
  const s = setup({ nodes: [poll], api: { leads: [{ id: 1, url: "https://www.linkedin.com/in/asha/" }, { id: 2, url: "https://www.linkedin.com/in/ravi/" }] } });
  await s.scheduler.tick();
  assert.equal(s.starts.length, 1);
  assert.deepEqual(s.starts[0].items.map((i) => i.profileUrl), ["https://www.linkedin.com/in/asha/", "https://www.linkedin.com/in/ravi/"]);
  assert.deepEqual(s.seen("poll"), ["1", "2"]);
  s.setNow(new Date(2026, 9, 8, 10, 31));
  await s.scheduler.tick();
  assert.equal(s.starts.length, 1, "the same records must not start a second run");
});

// Opening a browser to do nothing is the cost a poll with no news must avoid.
test("a poll with nothing new starts no run", async () => {
  const s = setup({ nodes: [poll], api: { leads: [] } });
  await s.scheduler.tick();
  assert.equal(s.starts.length, 0);
  assert.match(s.state("poll").lastResult, /0 new/);
});

// If the run never started, the records were never worked; marking them seen would drop those leads for good.
test("records are not marked seen when the run could not start", async () => {
  const s = setup({ nodes: [poll], startError: { message: "busy", code: "BUSY" }, api: { leads: [{ id: 1, url: "https://www.linkedin.com/in/asha/" }] } });
  await s.scheduler.tick();
  assert.deepEqual(s.seen("poll"), []);
});

test("an API error is recorded on the trigger and retried at the next interval", async () => {
  const failing = setup({ nodes: [poll], api: null });
  await failing.scheduler.tick();
  assert.match(failing.state("poll").lastError, /No list/);
  assert.equal(failing.state("poll").nextAt, new Date(2026, 9, 8, 10, 30).getTime());
});

test("a second tick while one is still running does nothing", async () => {
  const s = setup({ nodes: [poll], api: { leads: [{ id: 1, url: "https://www.linkedin.com/in/asha/" }] } });
  await Promise.all([s.scheduler.tick(), s.scheduler.tick()]);
  assert.equal(s.starts.length, 1);
});
