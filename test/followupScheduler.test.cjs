const test = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler } = require("../electron/scheduler.cjs");

const T0 = new Date(2026, 9, 8, 10, 0);
const row = (id, accountId, workflowId, nextDueAt = T0.getTime() - 1) => ({ id, accountId, workflowId, nextDueAt, status: "active" });

function setup({ rows, busy = new Set() }) {
  const starts = [];
  const store = { followups: { due: (t, acc) => rows.filter((r) => r.nextDueAt <= t && (!acc || r.accountId === acc)) }, workflows: { listActive: () => [] } };
  const runner = {
    start: async (workflowId, opts) => {
      const acc = opts.followups[0].accountId;
      if (busy.has(acc)) throw Object.assign(new Error("busy"), { code: "BUSY" });
      starts.push({ workflowId, firedBy: opts.firedBy, ids: opts.followups.map((r) => r.id) });
      return `run${starts.length}`;
    },
  };
  let now = T0;
  const scheduler = createScheduler({ store, runner, fetchJson: async () => null, now: () => now });
  return { scheduler, starts, busy, setNow: (d) => { now = d; } };
}

test("due follow-ups start one run per workflow, fired by followUp, with that workflow's rows", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1"), row("b", "acc1", "wf1"), row("c", "acc2", "wf2")] });
  await s.scheduler.tickFollowUps();
  assert.deepEqual(s.starts, [{ workflowId: "wf1", firedBy: "followUp", ids: ["a", "b"] }, { workflowId: "wf2", firedBy: "followUp", ids: ["c"] }]);
});

// Two runs on one account would open two browsers on one profile; the second workflow waits for a later pass.
test("an account with due rows in two workflows starts only one run per pass", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1"), row("b", "acc1", "wf2")] });
  await s.scheduler.tickFollowUps();
  assert.equal(s.starts.length, 1);
  assert.equal(s.starts[0].workflowId, "wf1");
});

test("rows not yet due start nothing", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1", T0.getTime() + 60_000)] });
  await s.scheduler.tickFollowUps();
  assert.equal(s.starts.length, 0);
});

test("a busy account is left alone for five minutes, then tried again", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1")], busy: new Set(["acc1"]) });
  await s.scheduler.tickFollowUps();
  s.busy.clear();
  s.setNow(new Date(T0.getTime() + 60_000));
  await s.scheduler.tickFollowUps();
  assert.equal(s.starts.length, 0, "still inside the back-off");
  s.setNow(new Date(T0.getTime() + 5 * 60_000 + 1));
  await s.scheduler.tickFollowUps();
  assert.equal(s.starts.length, 1);
});

test("send due now ignores the back-off but reports a busy account instead of pretending it sent", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1")], busy: new Set(["acc1"]) });
  await s.scheduler.tickFollowUps();
  await assert.rejects(s.scheduler.tickFollowUps({ accountId: "acc1", force: true }), /busy/);
  s.busy.clear();
  const started = await s.scheduler.tickFollowUps({ accountId: "acc1", force: true });
  assert.deepEqual(started, [{ accountId: "acc1", workflowId: "wf1", runId: "run1", due: 1 }]);
});

test("send due now for one account leaves other accounts' rows alone", async () => {
  const s = setup({ rows: [row("a", "acc1", "wf1"), row("c", "acc2", "wf2")] });
  await s.scheduler.tickFollowUps({ accountId: "acc2", force: true });
  assert.deepEqual(s.starts.map((x) => x.ids), [["c"]]);
});
