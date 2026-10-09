// Fires the Schedule and Poll API triggers of Active workflows, and sends due follow-ups, while the app is open. It decides when; the runner does the run.

const { nextRun } = require("./domain/schedule.cjs");
const { recordsAt, newRecords, toItems } = require("./domain/poll.cjs");
const { TRIGGERS } = require("./constants.cjs");

const MINUTE = 60_000;
const pollEvery = (p) => Math.max(TRIGGERS.POLL_MIN_MINUTES, Number(p.everyMinutes) || 30) * MINUTE;

// Fetches the API and works out which records are new. It does not mark them seen: the caller does that once the records have a run to go to.
async function pollNewItems({ store, workflowId, node, fetchJson }) {
  const p = node.params || {};
  let headers = {};
  if (String(p.headers || "").trim()) {
    try { headers = JSON.parse(p.headers); } catch { throw new Error("Headers must be a JSON object, like {\"Authorization\": \"Bearer …\"}"); }
  }
  const json = await fetchJson(p.url, { headers });
  const records = recordsAt(json, p.itemsPath);
  if (!records) throw new Error(`No list at "${p.itemsPath || "the top level"}" in the API answer`);
  const { fresh, keys } = newRecords(records, new Set(store.triggers.get(workflowId, node.id).seen), p.keyField || p.urlField);
  // Records past the cap stay unseen, so the next poll picks them up.
  const max = Math.max(1, Number(p.maxItems) || 25);
  const { items, rejected } = toItems(fresh.slice(0, max), p.urlField, p.itemKind);
  return { items, keys: keys.slice(0, max), rejected, total: records.length };
}

function createScheduler({ store, runner, fetchJson, now = () => new Date(), random = Math.random, onChange = () => {} }) {
  let busy = false;
  let timer = null;

  async function fireSchedule(wf, node, t) {
    await runner.start(wf.id, { firedBy: node.id });
    store.triggers.set(wf.id, node.id, { lastAt: t.getTime(), nextAt: nextRun(node.params, t, random)?.getTime() ?? null, lastError: null, lastResult: "started a run" });
  }

  async function firePoll(wf, node, t) {
    const { items, keys, rejected } = await pollNewItems({ store, workflowId: wf.id, node, fetchJson });
    if (items.length) await runner.start(wf.id, { firedBy: node.id, items });
    store.triggers.markSeen(wf.id, node.id, keys);
    store.triggers.set(wf.id, node.id, { lastAt: t.getTime(), nextAt: t.getTime() + pollEvery(node.params), lastError: null, lastResult: `${items.length} new${rejected ? `, ${rejected} without a usable link` : ""}` });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const workflowId of store.workflows.listActive()) {
        const wf = store.workflows.get(workflowId);
        if (!wf) continue;
        for (const node of wf.nodes.filter((n) => n.type === "schedule" || n.type === "pollApi")) {
          const t = now();
          const state = store.triggers.get(wf.id, node.id);
          if (state.nextAt == null) {
            // A poll checks as soon as it is switched on; a schedule waits for its first slot.
            const first = node.type === "pollApi" ? t.getTime() : nextRun(node.params, t, random)?.getTime() ?? null;
            store.triggers.set(wf.id, node.id, { nextAt: first });
            if (node.type === "schedule") continue;
          } else if (t.getTime() < state.nextAt) continue;
          try {
            if (node.type === "schedule") await fireSchedule(wf, node, t);
            else await firePoll(wf, node, t);
          } catch (err) {
            const retry = err.code === "BUSY" ? TRIGGERS.BUSY_RETRY_MINUTES * MINUTE : node.type === "pollApi" ? pollEvery(node.params) : null;
            const nextAt = retry ? t.getTime() + retry : nextRun(node.params, t, random)?.getTime() ?? null;
            store.triggers.set(wf.id, node.id, { nextAt, lastError: err.message });
          }
          onChange(wf.id);
        }
      }
    } finally {
      busy = false;
    }
  }

  // Follow-ups go out whether or not their workflow is Active: Active arms triggers, while a booked follow-up is a promise already made to a person.
  const accountRetryAt = new Map();
  let sending = false;

  // One run per account per pass: the first workflow with due rows gets the browser, the others start on a later pass once it is free. force (Send due now) ignores the busy back-off and reports why nothing started.
  async function tickFollowUps({ accountId = null, force = false } = {}) {
    if (sending && !force) return [];
    sending = true;
    const started = [];
    try {
      const t = now().getTime();
      const byAccount = new Map();
      for (const row of store.followups.due(t, accountId)) {
        const workflows = byAccount.get(row.accountId) || new Map();
        workflows.set(row.workflowId, [...(workflows.get(row.workflowId) || []), row]);
        byAccount.set(row.accountId, workflows);
      }
      for (const [acc, workflows] of byAccount) {
        if (!force && (accountRetryAt.get(acc) ?? 0) > t) continue;
        const [workflowId, rows] = workflows.entries().next().value;
        try {
          const runId = await runner.start(workflowId, { firedBy: "followUp", followups: rows });
          accountRetryAt.delete(acc);
          started.push({ accountId: acc, workflowId, runId, due: rows.length });
        } catch (err) {
          accountRetryAt.set(acc, t + TRIGGERS.BUSY_RETRY_MINUTES * MINUTE);
          if (force) throw err;
        }
      }
    } finally {
      sending = false;
    }
    return started;
  }

  return {
    tick,
    tickFollowUps,
    start: () => { timer = timer || setInterval(() => { tick().catch(() => {}); tickFollowUps().catch(() => {}); }, TRIGGERS.TICK_MS); },
    stop: () => { clearInterval(timer); timer = null; },
  };
}

module.exports = { createScheduler, pollNewItems };
