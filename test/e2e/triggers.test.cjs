// Triggers that fire on their own: Poll API against a local HTTP server and a Schedule that comes due, both through the real scheduler with a short tick.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { launch, chain, steps, profile } = require("./harness.cjs");

const apps = [];
after(async () => { for (const a of apps) await a.close(); });
const open = async (opts) => { const a = await launch(opts); apps.push(a); return a; };
// The trigger tests that need no relaunch share one app; each uses its own account and workflow.
let shared;
const sharedApp = async () => (shared ||= await open());

function leadsServer() {
  const state = { leads: [], hits: 0, status: 200 };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify(state.status === 200 ? { data: { leads: state.leads } } : { error: "nope" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, url: `http://127.0.0.1:${server.address().port}/leads`, close: () => server.close() })));
}

test("Poll API starts a run only for records it has not seen, and a poll with nothing new starts none", async () => {
  const api = await leadsServer();
  try {
    const app = await sharedApp();
    const a = await app.createAccount("poll");
    api.state.leads = [{ id: 1, linkedinUrl: profile("poll-one"), note: "Saw your form, Poll." }];
    const wf = await app.save(chain("poll", a.id, [
      { id: "poll", type: "pollApi", params: { url: api.url, headers: "", itemsPath: "data.leads", urlField: "linkedinUrl", keyField: "id", itemKind: "person", everyMinutes: 5, maxItems: 25 } },
      { id: "connect", type: "connect", params: { note: "{{note}}", perDay: 20, perWeek: 100 } },
    ]));
    await app.call("workflows.setActive", wf.id, true);
    const finishedRuns = async (n) => { const rows = await app.history({ workflowId: wf.id }); return rows.length >= n && rows.every((r) => r.status !== "running") && rows; };
    const first = await app.waitFor(() => finishedRuns(1), { what: "the first poll run" });
    assert.equal(first[0].firedBy, "pollApi");
    assert.equal(first[0].status, "finished");
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => [x.target, x.note]), [[profile("poll-one"), "Saw your form, Poll."]]);

    // Saving resets the trigger, so the next tick polls again at once instead of in five minutes.
    api.state.leads.push({ id: 2, linkedinUrl: profile("poll-two"), note: "Second lead." });
    await app.save(wf);
    const second = await app.waitFor(() => finishedRuns(2), { what: "the second poll run" });
    assert.equal(second.length, 2);
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => x.target), [profile("poll-one"), profile("poll-two")]);
    assert.deepEqual((await app.getRun(second[0].id)).outputs.poll.out.map((p) => p.profileUrl), [profile("poll-two")]);

    const hits = api.state.hits;
    await app.save(wf);
    await app.waitFor(() => api.state.hits > hits, { what: "a poll with nothing new" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await app.history({ workflowId: wf.id })).length, 2);
    const [trigger] = await app.call("workflows.triggers", wf.id);
    assert.match(trigger.lastResult, /^0 new/);
    await app.call("workflows.setActive", wf.id, false);
  } finally {
    api.close();
  }
});

test("A Poll API that answers with an error starts no run and shows the error on the trigger", async () => {
  const api = await leadsServer();
  try {
    const app = await sharedApp();
    const a = await app.createAccount("poll error");
    api.state.status = 401;
    const wf = await app.save(chain("poll error", a.id, [
      { id: "poll", type: "pollApi", params: { url: api.url, headers: "", itemsPath: "data.leads", urlField: "linkedinUrl", keyField: "id", itemKind: "person", everyMinutes: 5, maxItems: 25 } },
      { id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100 } },
    ]));
    await app.call("workflows.setActive", wf.id, true);
    const trigger = await app.waitFor(async () => (await app.call("workflows.triggers", wf.id)).find((t) => t.lastError), { what: "the trigger error" });
    assert.match(trigger.lastError, /HTTP 401/);
    assert.equal((await app.history({ workflowId: wf.id })).length, 0);
    await app.call("workflows.setActive", wf.id, false);
  } finally {
    api.close();
  }
});

test("Active refuses a workflow with no Schedule or Poll API trigger", async () => {
  const app = await sharedApp();
  const a = await app.createAccount("not schedulable");
  const wf = await app.save(chain("manual only", a.id, [{ id: "start", type: "start" }, { type: "urlList", params: { urls: profile("x-one"), itemKind: "person" } }]));
  await assert.rejects(app.call("workflows.setActive", wf.id, true), /Add a Schedule or Poll API trigger first/);
});

// A schedule's first slot is at least 15 minutes out, so the test switches it on, quits, and relaunches the same data with the scheduler clock 16 minutes ahead.
test("A Schedule that comes due runs only its own branch, not the Start branch beside it", async () => {
  const first = await open();
  const a = await first.createAccount("schedule");
  const wf = await first.save({
    name: "schedule", accountId: a.id,
    nodes: [
      { id: "schedule", type: "schedule", position: { x: 0, y: 0 }, params: { everyMinutes: 15, fromHour: 0, toHour: 24, days: "everyday", jitterMinutes: 0 } },
      { id: "scheduledLeads", type: "urlList", position: { x: 300, y: 0 }, params: { urls: profile("sched-lead"), itemKind: "person" } },
      { id: "scheduledConnect", type: "connect", position: { x: 600, y: 0 }, params: { note: "", perDay: 20, perWeek: 100 } },
      { id: "start", type: "start", position: { x: 0, y: 200 }, params: {} },
      { id: "manualLeads", type: "urlList", position: { x: 300, y: 200 }, params: { urls: profile("manual-lead"), itemKind: "person" } },
      { id: "manualConnect", type: "connect", position: { x: 600, y: 200 }, params: { note: "", perDay: 20, perWeek: 100 } },
    ],
    edges: [
      { id: "s1", source: "schedule", sourceHandle: "out", target: "scheduledLeads" }, { id: "s2", source: "scheduledLeads", sourceHandle: "out", target: "scheduledConnect" },
      { id: "m1", source: "start", sourceHandle: "out", target: "manualLeads" }, { id: "m2", source: "manualLeads", sourceHandle: "out", target: "manualConnect" },
    ],
  });
  await first.call("workflows.setActive", wf.id, true);
  const state = await first.waitFor(async () => (await first.call("workflows.triggers", wf.id)).find((t) => t.nodeId === "schedule" && t.nextAt), { what: "the schedule's first slot" });
  assert.ok(state.nextAt - Date.now() >= 14 * 60_000, "a schedule never fires the moment it is switched on");
  assert.equal((await first.history({ workflowId: wf.id })).length, 0);
  await first.close();

  const later = await open({ userData: first.dir, env: { OUTREACH_CLOCK_OFFSET_MS: String(16 * 60_000) } });
  const [row] = await later.waitFor(async () => { const rows = await later.history({ workflowId: wf.id }); return rows.length && rows[0].status !== "running" && rows; }, { what: "the scheduled run" });
  assert.equal(row.firedBy, "schedule");
  assert.equal(row.status, "finished");
  const run = await later.getRun(row.id);
  assert.equal(steps(run).start.state, "skipped");
  assert.deepEqual(later.actions({ accountId: a.id, action: "connect" }).map((x) => x.target), [profile("sched-lead")]);
  await later.call("workflows.setActive", wf.id, false);
});
