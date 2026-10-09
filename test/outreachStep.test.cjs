const test = require("node:test");
const assert = require("node:assert/strict");
const { catalog } = require("../electron/nodes.cjs");

const H = 3600_000, D = 24 * H;
const step = catalog.outreachSequence;
const params = { ...Object.fromEntries(step.params.map((p) => [p.key, p.default])), intro: "Hi {{firstName}}, intro", followUp1: "Hi {{firstName}}, fu1", followUp2: "Hi {{firstName}}, fu2", calendarMessage: "Book here {{calendarLink}}", minGapSeconds: 0, maxGapSeconds: 0 };

function world({ outreach = {}, ledger = [], calendarLink = "https://cal.com/shivam", messagesToday = 0 } = {}) {
  const contacts = new Map();
  const recorded = [];
  const stageChanges = [];
  const settings = { "outreach.calendarLink": calendarLink };
  const store = {
    settings: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } },
    actions: {
      countSince: (_a, action) => (action === "message" ? messagesToday : 0) + recorded.filter((r) => r.action === action && r.status === "sent").length,
      record: (r) => recorded.push(r),
      forTarget: (_a, target) => ledger.filter((l) => l.target === target),
    },
    crm: {
      contacts: {
        find: (_a, url) => contacts.get(url) || null,
        upsert: ({ item }) => { if (!contacts.has(item.profileUrl)) contacts.set(item.profileUrl, { id: item.profileUrl, outreach: outreach[item.profileUrl] || null }); return item.profileUrl; },
        getOutreach: (id) => contacts.get(id)?.outreach || null,
        setOutreach: (id, o) => { contacts.get(id).outreach = o; },
        update: (id, { stage }) => stageChanges.push([id, stage]),
        refreshStage: () => {},
        markReplied: (_a, url) => stageChanges.push([url, "replied"]),
      },
    },
  };
  for (const url of Object.keys(outreach)) store.crm.contacts.upsert({ item: { profileUrl: url } });
  return { store, recorded, stageChanges, outreachOf: (url) => contacts.get(url)?.outreach };
}

function linkedinWith({ degree = {}, threads = {}, sendStatus = "sent" } = {}) {
  const calls = [];
  return {
    calls,
    readProfile: async (url) => { calls.push(["profile", url]); return { degree: degree[url] ?? "2nd" }; },
    readThread: async (p) => { calls.push(["thread", p.profileUrl]); return { messages: threads[p.profileUrl] ?? [] }; },
    sendMessage: async (p, text, opts) => { calls.push(["send", p.profileUrl, text, !!opts?.intoExistingThread]); return { status: sendStatus }; },
    pause: async () => {},
  };
}

function ctxWith(w, linkedin, llmClass = "interested") {
  const events = [];
  return { events, store: w.store, accountId: "acc", runId: "run", workflowId: "wf", emit: (e) => events.push(e), shouldStop: () => false, linkedin, llm: { chatJson: async () => ({ ok: true, value: { class: llmClass, reason: "said so" } }) } };
}

const asha = { kind: "person", name: "Asha Rao", firstName: "Asha", profileUrl: "u/asha" };
const me = (text, at) => ({ fromMe: true, text, at });
const them = (text, at) => ({ fromMe: false, text, at });

test("an invite not yet accepted is checked and left waiting, with nothing sent", async () => {
  const w = world({ ledger: [{ target: "u/asha", action: "connect", status: "sent", at: Date.now() - D }] });
  const li = linkedinWith();
  const out = await step.run([asha], params, ctxWith(w, li));
  assert.equal(out.waiting.length, 1);
  assert.equal(li.calls.filter((c) => c[0] === "send").length, 0);
  assert.equal(w.outreachOf("u/asha").state, "invited");
});

test("an accepted invite with an empty conversation gets the intro, in a new thread", async () => {
  const w = world({ ledger: [{ target: "u/asha", action: "connect", status: "sent", at: Date.now() - D }] });
  const li = linkedinWith({ degree: { "u/asha": "1st" } });
  const out = await step.run([asha], params, ctxWith(w, li));
  assert.deepEqual(li.calls.find((c) => c[0] === "send"), ["send", "u/asha", "Hi Asha, intro", false]);
  assert.equal(out.sent.length, 1);
  assert.equal(w.outreachOf("u/asha").state, "intro_sent");
  assert.equal(w.recorded[0].action, "message");
});

test("no reply two days after the intro sends follow-up one into the same conversation", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "Hi Asha, intro", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Hi Asha, intro", sentAt)] } });
  await step.run([asha], params, ctxWith(w, li));
  assert.deepEqual(li.calls.find((c) => c[0] === "send"), ["send", "u/asha", "Hi Asha, fu1", true]);
  assert.equal(w.outreachOf("u/asha").state, "followup1_sent");
  assert.equal(w.recorded[0].action, "followup");
});

test("an interested reply gets the calendar link and moves the CRM stage to Calendar sent", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "Hi Asha, intro", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Hi Asha, intro", sentAt), them("Sure, happy to chat", sentAt + H)] } });
  await step.run([asha], params, ctxWith(w, li, "interested"));
  assert.deepEqual(li.calls.find((c) => c[0] === "send"), ["send", "u/asha", "Book here https://cal.com/shivam", true]);
  assert.equal(w.outreachOf("u/asha").state, "calendar_sent");
  assert.ok(w.stageChanges.some(([, s]) => s === "calendar_sent"));
});

// Sending "Book here " with no link would look broken to someone who just said yes.
test("with no calendar link set, an interested reply is an error and nothing is sent", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ calendarLink: "", outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "Hi Asha, intro", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Hi Asha, intro", sentAt), them("Sure!", sentAt + H)] } });
  const ctx = ctxWith(w, li, "interested");
  await step.run([asha], params, ctx);
  assert.equal(li.calls.filter((c) => c[0] === "send").length, 0);
  assert.ok(ctx.events.some((e) => e.type === "item.failed" && /calendar link/.test(e.message)));
});

test("a reply the AI cannot place stops the sequence and asks for the owner", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "Hi Asha, intro", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Hi Asha, intro", sentAt), them("What does it cost?", sentAt + H)] } });
  const out = await step.run([asha], params, ctxWith(w, li, "other"));
  assert.equal(out.needsYou.length, 1);
  assert.equal(w.outreachOf("u/asha").state, "needs_you");
  assert.equal(li.calls.filter((c) => c[0] === "send").length, 0);
});

test("a booked reply closes the person as Meeting booked", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ outreach: { "u/asha": { state: "calendar_sent", sent: [{ kind: "calendar", text: "Book here https://cal.com/shivam", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Book here https://cal.com/shivam", sentAt), them("Done, booked Thursday", sentAt + H)] } });
  const out = await step.run([asha], params, ctxWith(w, li, "booked"));
  assert.equal(out.closed.length, 1);
  assert.ok(w.stageChanges.some(([, s]) => s === "meeting"));
});

test("an answer typed by the owner hands the person over and nothing more is sent", async () => {
  const sentAt = Date.now() - 3 * D;
  const w = world({ outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "Hi Asha, intro", at: sentAt }], lastCheckedAt: sentAt } } });
  const li = linkedinWith({ threads: { "u/asha": [me("Hi Asha, intro", sentAt), them("tell me more", sentAt + H), me("Here's a quick video", sentAt + 2 * H)] } });
  await step.run([asha], params, ctxWith(w, li));
  assert.equal(w.outreachOf("u/asha").state, "manual");
  assert.equal(li.calls.filter((c) => c[0] === "send").length, 0);
});

test("a person looked at an hour ago is skipped without opening anything", async () => {
  const w = world({ outreach: { "u/asha": { state: "intro_sent", sent: [{ kind: "intro", text: "x", at: Date.now() - 3 * D }], lastCheckedAt: Date.now() - H } } });
  const li = linkedinWith();
  await step.run([asha], params, ctxWith(w, li));
  assert.deepEqual(li.calls, []);
});

test("the per-run cap stops sending once reached", async () => {
  const ledger = ["u/a", "u/b", "u/c"].map((target) => ({ target, action: "connect", status: "sent", at: Date.now() - D }));
  const w = world({ ledger });
  const li = linkedinWith({ degree: { "u/a": "1st", "u/b": "1st", "u/c": "1st" } });
  const people = ["a", "b", "c"].map((n) => ({ kind: "person", name: `P ${n}`, firstName: "P", profileUrl: `u/${n}` }));
  await step.run(people, { ...params, perRun: 2 }, ctxWith(w, li));
  assert.equal(li.calls.filter((c) => c[0] === "send").length, 2);
});

// The message may have gone; sending follow-up one on top of an unconfirmed intro would double up.
test("an unconfirmed send hands the person to the owner instead of carrying on", async () => {
  const w = world({ ledger: [{ target: "u/asha", action: "connect", status: "sent", at: Date.now() - D }] });
  const li = linkedinWith({ degree: { "u/asha": "1st" }, sendStatus: "unverified" });
  const out = await step.run([asha], params, ctxWith(w, li));
  assert.equal(out.needsYou.length, 1);
  assert.equal(w.outreachOf("u/asha").state, "needs_you");
});

test("someone this account messaged outside the sequence is left alone", async () => {
  const w = world({ ledger: [{ target: "u/asha", action: "message", status: "sent", at: Date.now() - D }] });
  const li = linkedinWith({ degree: { "u/asha": "1st" } });
  await step.run([asha], params, ctxWith(w, li));
  assert.deepEqual(li.calls, []);
  assert.equal(w.outreachOf("u/asha").state, "manual");
});

test("the calendar message must contain the link placeholder", () => {
  assert.ok(step.validate({ ...params, calendarMessage: "Book a slot" }).some((m) => /calendarLink/.test(m)));
  assert.deepEqual(step.validate(params), []);
});
