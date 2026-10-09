const test = require("node:test");
const assert = require("node:assert/strict");
const { catalog, sendDueFollowUps } = require("../electron/nodes.crm.cjs");
const { DAY_MS } = require("../electron/domain/followup.cjs");

const NOW = Date.now();
const person = (n) => ({ kind: "person", name: `Person ${n}`, profileUrl: `https://www.linkedin.com/in/p${n}/` });
const steps = [{ afterDays: 3, text: "Hi {{firstName}}, following up." }, { afterDays: 7, text: "Last one, {{firstName}}." }];

// A stand-in for the store's follow-up and ledger methods, keeping rows in memory the way the SQLite version does.
function fakeStore({ lastSent = {}, sentToday = 0 } = {}) {
  const rows = new Map();
  const recorded = [];
  const replied = [];
  let n = 0;
  const followups = {
    hasActive: (a, url) => [...rows.values()].some((r) => r.accountId === a && r.profileUrl === url && r.status === "active"),
    enroll: (r) => { if (followups.hasActive(r.accountId, r.profileUrl)) return null; const row = { ...r, id: `f${++n}`, stepIndex: 0, totalSteps: r.steps.length, status: "active", failures: 0, nextDueAt: r.lastSentAt + r.steps[0].afterDays * DAY_MS, history: [] }; rows.set(row.id, row); return row; },
    get: (id) => rows.get(id) || null,
    markSent: (id, { text }) => { const r = rows.get(id); r.stepIndex++; r.lastSentAt = Date.now(); r.history.push({ status: "sent", text }); r.status = r.stepIndex >= r.totalSteps ? "done" : "active"; r.nextDueAt = r.status === "active" ? r.lastSentAt + r.steps[r.stepIndex].afterDays * DAY_MS : null; },
    markReplied: (id) => { rows.get(id).status = "replied"; },
    markDone: (id) => { rows.get(id).status = "done"; },
    markFailed: (id, e) => { Object.assign(rows.get(id), { status: "failed", failText: e.text }); },
    retryLater: (id, { at }) => { const r = rows.get(id); r.failures++; r.nextDueAt = at; },
    endOnReply: (a, url) => { let k = 0; for (const r of rows.values()) if (r.accountId === a && r.profileUrl === url && r.status === "active" && r.stopOnReply) { r.status = "replied"; k++; } return k; },
  };
  return {
    rows, recorded, replied, followups,
    actions: {
      lastSentAt: (_a, url) => lastSent[url] ?? null,
      countSince: () => sentToday + recorded.filter((r) => r.action === "followup" && r.status === "sent").length,
      record: (r) => recorded.push(r),
    },
    crm: { contacts: { markReplied: (_a, url) => replied.push(url) } },
  };
}

function ctxWith(overrides) {
  const events = [];
  return { events, accountId: "acc", runId: "run", workflowId: "wf", nodeId: "fu", emit: (e) => events.push(e), shouldStop: () => false, linkedin: { pause: async () => {} }, ...overrides };
}

const params = { steps, stopOnReply: "yes", perDay: 20 };

test("enrolling books the first follow-up its days after the last message and sends nothing", async () => {
  const store = fakeStore({ lastSent: { [person(1).profileUrl]: NOW - DAY_MS } });
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, sendMessage: async () => { throw new Error("must not send"); } } });
  const { out } = await catalog.followUp.run([person(1)], params, ctx);
  assert.equal(out.length, 1);
  const row = [...store.rows.values()][0];
  assert.equal(row.nextDueAt, NOW - DAY_MS + 3 * DAY_MS);
  assert.equal(row.workflowId, "wf");
  assert.equal(row.nodeId, "fu");
});

// A follow-up without a first message is a cold message that skipped the Message step's checks.
test("people this account never messaged are not enrolled", async () => {
  const store = fakeStore();
  const { out } = await catalog.followUp.run([person(1)], params, ctxWith({ store }));
  assert.equal(out.length, 0);
  assert.equal(store.rows.size, 0);
});

test("an item the Message step just marked messaged can be enrolled", async () => {
  const store = fakeStore();
  const { out } = await catalog.followUp.run([{ ...person(1), messaged: "Hi" }], params, ctxWith({ store }));
  assert.equal(out.length, 1);
});

test("a person already in an active sequence is not enrolled twice", async () => {
  const store = fakeStore({ lastSent: { [person(1).profileUrl]: NOW } });
  await catalog.followUp.run([person(1)], params, ctxWith({ store }));
  const { out } = await catalog.followUp.run([person(1)], params, ctxWith({ store }));
  assert.equal(out.length, 0);
  assert.equal(store.rows.size, 1);
});

test("a sequence with an empty message fails validation in the editor", () => {
  assert.deepEqual(catalog.followUp.validate(params), []);
  assert.match(catalog.followUp.validate({ ...params, steps: [{ afterDays: 2, text: "" }] })[0], /empty/);
});

// Enrol someone whose first follow-up is already due, as if three days had passed.
async function dueRow(store, opts = {}) {
  store.actions.lastSentAt = () => NOW - 4 * DAY_MS;
  await catalog.followUp.run([person(1)], { ...params, ...opts }, ctxWith({ store }));
  return [...store.rows.values()][0];
}
const mine = (text) => ({ fromMe: true, text, at: null });
const theirs = (text) => ({ fromMe: false, text, at: null });

test("a due follow-up with no reply sends the next message into the thread and books the one after", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  const sent = [];
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => ({ messages: [mine("Hi")] }), sendMessage: async (p, text, opts) => { sent.push({ text, opts }); return { status: "sent" }; } } });
  const outputs = await sendDueFollowUps([row], ctx);
  assert.deepEqual(sent, [{ text: "Hi Person, following up.", opts: { intoExistingThread: true } }]);
  assert.equal(store.recorded[0].action, "followup");
  assert.equal(store.rows.get(row.id).stepIndex, 1);
  assert.equal(store.rows.get(row.id).status, "active");
  assert.equal(outputs.fu.out.length, 1);
  assert.ok(ctx.events.some((e) => e.type === "node.finished" && e.nodeId === "fu"));
});

test("a reply after our last message stops the sequence and marks the contact replied", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  let sends = 0;
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => ({ messages: [mine("Hi"), theirs("Sounds good")] }), sendMessage: async () => { sends++; return { status: "sent" }; } } });
  await sendDueFollowUps([row], ctx);
  assert.equal(sends, 0);
  assert.equal(store.rows.get(row.id).status, "replied");
  assert.deepEqual(store.replied, [person(1).profileUrl]);
});

// The one failure that must never happen: nagging someone who answered because their reply could not be read.
test("a thread that cannot be read sends nothing and is retried later", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  let sends = 0;
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => ({ messages: null, reason: "no message list" }), sendMessage: async () => { sends++; return { status: "sent" }; } } });
  await sendDueFollowUps([row], ctx);
  assert.equal(sends, 0);
  assert.equal(store.rows.get(row.id).status, "active");
  assert.equal(store.rows.get(row.id).failures, 1);
  assert.ok(store.rows.get(row.id).nextDueAt > Date.now());
  assert.ok(ctx.events.some((e) => e.type === "item.failed" && /no message list/.test(e.message)));
});

test("a row that keeps failing to read is marked failed after the last attempt", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  store.rows.get(row.id).failures = 2;
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => ({ messages: null, reason: "x" }) } });
  await sendDueFollowUps([row], ctx);
  assert.equal(store.rows.get(row.id).status, "failed");
});

// An unverified send may have gone through; trying again could message them twice.
test("an unverified send is recorded and the row is failed, not retried", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => ({ messages: [mine("Hi")] }), sendMessage: async () => ({ status: "unverified" }) } });
  const outputs = await sendDueFollowUps([row], ctx);
  assert.equal(store.recorded[0].status, "unverified");
  assert.equal(store.rows.get(row.id).status, "failed");
  assert.equal(outputs.fu.out.length, 0);
});

test("the daily follow-up allowance holds a due row back without touching LinkedIn", async () => {
  const store = fakeStore({ sentToday: 20 });
  const row = await dueRow(store);
  let opened = false;
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => { opened = true; return { messages: [] }; } } });
  await sendDueFollowUps([row], ctx);
  assert.equal(opened, false);
  assert.equal(store.rows.get(row.id).status, "active");
});

test("a row cancelled after the scheduler picked it is skipped", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  store.rows.get(row.id).status = "cancelled";
  let opened = false;
  await sendDueFollowUps([row], ctxWith({ store, linkedin: { pause: async () => {}, readThread: async () => { opened = true; } } }));
  assert.equal(opened, false);
});

test("check replies splits people by whether they wrote back, and ends their stop-on-reply sequences", async () => {
  const store = fakeStore();
  const row = await dueRow(store);
  const threads = { [person(1).profileUrl]: [mine("Hi"), theirs("Yes please")], [person(2).profileUrl]: [mine("Hi")] };
  const ctx = ctxWith({ store, linkedin: { pause: async () => {}, readThread: async (p) => ({ messages: threads[p.profileUrl] }) } });
  const { replied, noReply } = await catalog.checkReplies.run([person(1), person(2)], {}, ctx);
  assert.deepEqual(replied.map((p) => p.reply), ["Yes please"]);
  assert.deepEqual(noReply.map((p) => p.name), ["Person 2"]);
  assert.equal(store.rows.get(row.id).status, "replied");
});

test("check replies fails a person whose conversation cannot be read instead of calling it no reply", async () => {
  const ctx = ctxWith({ store: fakeStore(), linkedin: { pause: async () => {}, readThread: async () => ({ messages: null, reason: "not a 1st-degree connection" }) } });
  const { replied, noReply } = await catalog.checkReplies.run([person(1)], {}, ctx);
  assert.equal(replied.length + noReply.length, 0);
  assert.ok(ctx.events.some((e) => e.type === "item.failed"));
});

test("every CRM step sits in its contract group with an icon", () => {
  assert.deepEqual(Object.entries(catalog).map(([t, d]) => [t, d.group, d.icon]), [["followUp", "Messaging", "CalendarClock"], ["checkReplies", "Messaging", "Inbox"], ["outreachSequence", "Messaging", "MessagesSquare"], ["crmSource", "CRM", "Database"], ["crmUpdate", "CRM", "Tags"]]);
});

test("From CRM emits the account's contacts as people, filtered by stage and tag", async () => {
  let asked;
  const store = { crm: { contacts: { list: (q) => { asked = q; return { rows: [{ id: "c1", profileUrl: "u1", name: "Asha Rao", headline: "CEO", stage: "replied", tags: ["hot"], data: { evaluation: { score: 9 } } }], total: 1 }; } } } };
  const { out } = await catalog.crmSource.run([], { stage: "replied", tag: " hot ", limit: 10 }, ctxWith({ store }));
  assert.deepEqual(asked, { accountId: "acc", stage: "replied", tag: "hot", limit: 10 });
  assert.equal(out[0].firstName, "Asha");
  assert.equal(out[0].kind, "person");
  assert.deepEqual(out[0].evaluation, { score: 9 });
});

test("Update CRM adds tags to the existing ones, sets the stage and writes the note", async () => {
  const calls = [];
  const store = { crm: { contacts: {
    upsert: () => "c1",
    find: () => ({ id: "c1", tags: ["old"] }),
    update: (id, patch, how) => { calls.push(["update", patch, how.why]); return { id, stage: patch.stage, tags: patch.tags }; },
    addNote: (_id, text) => calls.push(["note", text]),
  } } };
  const { out } = await catalog.crmUpdate.run([{ ...person(1), name: "Asha Rao" }], { stage: "qualified", addTags: "hot, b2b", note: "Talked to {{firstName}}" }, ctxWith({ store }));
  assert.deepEqual(calls, [["update", { stage: "qualified", tags: ["old", "hot", "b2b"] }, "set by a workflow step"], ["note", "Talked to Asha"]]);
  assert.equal(out[0].crm.stage, "qualified");
});
