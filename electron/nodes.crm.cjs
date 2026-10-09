// CRM and follow-up steps, merged into the catalog by nodes.cjs, plus the sender the scheduler's follow-up runs use. Enrolling in a sequence only writes rows; sending happens later in sendDueFollowUps.

const { render, renderOutgoing } = require("./domain/text.cjs");
const { STAGES, parseTags } = require("./domain/crm.cjs");
const { parseSequence, canEnroll, hasReplied, nextAction } = require("./domain/followup.cjs");
const { LIMITS, FOLLOWUP } = require("./constants.cjs");
const { DAY, eachItem, withFirstName } = require("./steps.cjs");
const { shouldCheck, afterProfile, afterThread, afterReply, sentState, nextActionOf, isTerminal } = require("./domain/outreach.cjs");
const { readAnswer, outputInstruction } = require("./domain/aiOutput.cjs");
const { remainingBudget, runAllowance } = require("./domain/qualify.cjs");

// What the AI must say about a reply; a choice field so anything outside these four is unreadable, never a guess.
const REPLY_FIELDS = [
  { name: "class", type: "choice", choices: "interested, booked, not_interested, other", description: "interested = happy to talk or wants details; booked = says a meeting is booked or scheduled; not_interested = declines or asks to stop; other = anything a person should answer" },
  { name: "reason", type: "text", description: "one short sentence quoting what decided it" },
];

// Where a person starts when the sequence first sees them, from what the ledger already shows this account did.
function startingOutreach(store, accountId, person, now) {
  const history = store.actions.forTarget(accountId, person.profileUrl);
  const invite = history.find((a) => a.action === "connect" && ["sent", "pending"].includes(a.status));
  const messaged = history.some((a) => ["message", "followup"].includes(a.action) && a.status === "sent");
  // A message this sequence did not send means the conversation already has an owner; the sequence stays out of it.
  if (messaged) return { state: "manual", sent: [], note: "messaged outside this sequence", lastCheckedAt: now };
  if (/^1st/i.test(String(person.degree || "")) && !invite) return { state: "connected", sent: [], connectedAt: now, lastCheckedAt: null };
  return { state: "invited", invitedAt: invite?.at || now, sent: [], lastCheckedAt: null };
}

const HOUR = 60 * 60 * 1000;
const STAGE_OPTIONS = STAGES.map((s) => [s.id, s.label]);
const lastReplyOf = (messages) => [...(messages || [])].reverse().find((m) => !m.fromMe)?.text || null;

const catalog = {
  followUp: {
    // Superseded by Outreach sequence, which keeps follow-ups on each person in the CRM; kept so workflows already using it still run, but not offered for new ones.
    hidden: true,
    label: "Follow-up sequence", group: "Messaging", icon: "CalendarClock",
    description: "Books follow-up messages for people this account already messaged. Sends nothing now: each message goes out its set number of days after the one before, unless they reply first. Emits the people it enrolled.",
    input: "person", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "steps", label: "Follow-up messages", kind: "sequence", required: true, default: [{ afterDays: 3, text: "Hi {{firstName}}, just following up on my last message." }, { afterDays: 7, text: "Hi {{firstName}}, one last nudge from me." }], help: "Each one goes this many days after the message before it. {{firstName}} and other fields work." },
      { key: "stopOnReply", label: "Stop when they reply", kind: "select", default: "yes", options: [["yes", "Yes"], ["no", "No, send every message"]] },
      { key: "perDay", label: "Max follow-ups per 24 hours", kind: "number", default: LIMITS.FOLLOWUP_PER_DAY },
    ],
    validate: (p) => { const r = parseSequence(p.steps); return r.error ? [`Follow-up sequence: ${r.error}`] : []; },
    run: async (people, p, ctx) => {
      const seq = parseSequence(p.steps);
      if (seq.error) throw new Error(seq.error);
      const { store, accountId } = ctx;
      const out = await eachItem(people, ctx, async (person) => {
        if (!person.profileUrl) throw new Error("has no profile link");
        // The ledger is the proof; an item marked messaged by a source outside this app is taken at its word, from now.
        const lastSentAt = store.actions.lastSentAt(accountId, person.profileUrl) ?? (person.messaged ? Date.now() : null);
        const check = canEnroll({ lastSentAt, hasActive: store.followups.hasActive(accountId, person.profileUrl) });
        if (!check.ok) { ctx.emit({ type: "log", message: `${person.name || person.profileUrl}: not enrolled, ${check.reason}` }); return null; }
        const row = store.followups.enroll({ accountId, profileUrl: person.profileUrl, name: person.name, workflowId: ctx.workflowId, nodeId: ctx.nodeId, steps: seq.steps, stopOnReply: p.stopOnReply !== "no", perDay: Number(p.perDay) || LIMITS.FOLLOWUP_PER_DAY, lastSentAt, data: person });
        if (!row) { ctx.emit({ type: "log", message: `${person.name || person.profileUrl}: not enrolled, already in an active sequence` }); return null; }
        ctx.emit({ type: "log", message: `${person.name || person.profileUrl}: enrolled, first follow-up due ${new Date(row.nextDueAt).toLocaleString()}` });
        return { ...person, followUp: { id: row.id, nextDueAt: row.nextDueAt, totalSteps: row.totalSteps } };
      });
      return { out };
    },
  },

  checkReplies: {
    label: "Check replies", group: "Messaging", icon: "Inbox",
    description: "Opens each person's conversation and splits them by whether they wrote back after this account's last message. A conversation that cannot be read is an error, never a no.",
    input: "person", outputs: [{ handle: "replied", kind: "same" }, { handle: "noReply", kind: "same" }], params: [],
    run: async (people, _p, ctx) => {
      const { store, accountId, runId } = ctx;
      const replied = [], noReply = [];
      await eachItem(people, ctx, async (person) => {
        if (!person.profileUrl) throw new Error("has no profile link");
        const thread = await ctx.linkedin.readThread(person);
        const answer = hasReplied(thread?.messages ?? null, store.actions.lastSentAt(accountId, person.profileUrl));
        await ctx.linkedin.pause();
        if (answer === null) throw new Error(`could not tell whether they replied: ${thread?.reason || "the conversation read empty after a message was sent"}`);
        if (!answer) { noReply.push(person); return; }
        store.crm.contacts.markReplied(accountId, person.profileUrl, { item: person, runId });
        const ended = store.followups.endOnReply(accountId, person.profileUrl, runId);
        ctx.emit({ type: "log", message: `${person.name || person.profileUrl}: replied${ended ? "; their follow-up sequence stops" : ""}` });
        replied.push({ ...person, replied: true, reply: lastReplyOf(thread.messages) });
      });
      return { replied, noReply };
    },
  },

  outreachSequence: {
    label: "Outreach sequence", group: "Messaging", icon: "MessagesSquare",
    description: "Runs each person through invite accepted → intro → two follow-ups → drop, and answers replies: interested gets your calendar link, a booking or a no closes them, anything else waits for you. Stops for anyone you have answered by hand. Each person is looked at no more than every few hours.",
    input: "person", outputs: [{ handle: "sent", kind: "person" }, { handle: "needsYou", kind: "person" }, { handle: "waiting", kind: "person" }, { handle: "closed", kind: "person" }],
    params: [
      { key: "intro", label: "Intro message, sent once they accept (no calendar link)", kind: "textarea", required: true, default: "Hi {{firstName}}, thanks for connecting! Would love to hear what you are working on." },
      { key: "followUp1", label: "Follow-up 1 (blank = none)", kind: "textarea", default: "Hi {{firstName}}, just bumping this in case it got buried." },
      { key: "followUp2", label: "Follow-up 2 (blank = none)", kind: "textarea", default: "Hi {{firstName}}, one last nudge from me. No worries if now is not a good time." },
      { key: "calendarMessage", label: "Message with your calendar link, sent when they reply that they are happy to talk", kind: "textarea", required: true, default: "Great, {{firstName}}! Here is my calendar, pick any slot that works for you: {{calendarLink}}" },
      { key: "cadenceDays", label: "Days to wait for a reply before each follow-up", kind: "number", default: 2 },
      { key: "checkEveryHours", label: "Look at each person at most every (hours)", kind: "number", default: 6 },
      { key: "giveUpInviteDays", label: "Stop waiting for an invite to be accepted after (days)", kind: "number", default: 21 },
      { key: "replyPrompt", label: "How the AI should read a reply", kind: "textarea", required: true, default: "Read the person's reply to our LinkedIn outreach and say what they mean." },
      { key: "perRun", label: "Max messages per run", kind: "number", default: 15 },
      { key: "perDay", label: "Max messages per 24 hours (intro, follow-ups and calendar together)", kind: "number", default: 40 },
      { key: "minGapSeconds", label: "Wait between messages, at least (seconds)", kind: "number", default: 20 },
      { key: "maxGapSeconds", label: "Wait between messages, at most (seconds)", kind: "number", default: 60 },
    ],
    validate: (p) => {
      const problems = [];
      if (!(Number(p.cadenceDays) >= 1)) problems.push("Wait at least 1 day between follow-ups");
      if (!String(p.calendarMessage || "").includes("{{calendarLink}}")) problems.push("The calendar message must include {{calendarLink}}");
      return problems;
    },
    run: async (people, p, ctx) => {
      const { store, accountId, runId } = ctx;
      const params = { cadenceDays: Number(p.cadenceDays) || 2, checkEveryHours: Number(p.checkEveryHours) || 0, giveUpInviteDays: Number(p.giveUpInviteDays) || 21, followUps: [p.followUp1, p.followUp2] };
      const texts = { intro: p.intro, followup1: p.followUp1, followup2: p.followUp2, calendar: p.calendarMessage };
      const used = (ms) => store.actions.countSince(accountId, "message", Date.now() - ms) + store.actions.countSince(accountId, "followup", Date.now() - ms);
      let budget = Math.min(remainingBudget({ usedToday: used(DAY), perDay: p.perDay, usedThisWeek: 0, perWeek: null }), runAllowance({ perRun: p.perRun }));
      const gap = Number(p.maxGapSeconds) > 0 ? [Number(p.minGapSeconds) * 1000, Number(p.maxGapSeconds) * 1000] : undefined;
      const calendarLink = store.settings.get("outreach.calendarLink") || "";
      const out = { sent: [], needsYou: [], waiting: [], closed: [] };
      let notDue = 0, finished = 0;
      ctx.emit({ type: "log", message: `Message allowance this run: ${budget}` });

      await eachItem(people, ctx, async (person) => {
        const contactId = person.crm?.id || store.crm.contacts.find(accountId, person.profileUrl)?.id || store.crm.contacts.upsert({ accountId, item: person, workflowId: ctx.workflowId, runId });
        const now = Date.now();
        let o = store.crm.contacts.getOutreach(contactId) || startingOutreach(store, accountId, person, now);
        if (isTerminal(o.state)) { finished++; if (!store.crm.contacts.getOutreach(contactId)) store.crm.contacts.setOutreach(contactId, o); return null; }
        if (!shouldCheck(o, now, params)) { notDue++; return null; }
        const who = person.name || person.profileUrl;
        const save = (patch, bucket, extra = {}) => {
          o = { ...o, ...patch };
          o.nextAction = nextActionOf(o, params);
          store.crm.contacts.setOutreach(contactId, o);
          if (bucket) out[bucket].push({ ...withFirstName(person), outreach: { state: o.state, ...extra } });
          return null;
        };

        if (o.state === "invited") {
          const profile = await ctx.linkedin.readProfile(person.profileUrl);
          const { state } = afterProfile(o, profile.degree, now, params);
          if (state === "invite_stale") { ctx.emit({ type: "log", message: `${who}: invite not accepted in ${params.giveUpInviteDays} days, giving up` }); return save({ state, lastCheckedAt: now }, "closed"); }
          if (state === "invited") return save({ lastCheckedAt: now }, "waiting");
          o = { ...o, state: "connected", connectedAt: now };
          store.crm.contacts.upsert({ accountId, item: { ...person, degree: "1st" }, workflowId: ctx.workflowId, runId });
          ctx.emit({ type: "log", message: `${who}: accepted the invite` });
        }

        const thread = await ctx.linkedin.readThread(person);
        const d = afterThread(o, thread?.messages ?? null, now, params);
        if (d.do === "unknown") { save({ lastCheckedAt: now }); throw new Error(`could not read the conversation: ${thread?.reason || "it read empty after we had sent a message"}`); }
        if (d.do === "manual") { ctx.emit({ type: "log", message: `${who}: you have answered by hand, the sequence stops` }); return save({ state: "manual", lastCheckedAt: now }, "closed"); }
        if (d.do === "wait") return save({ lastCheckedAt: now }, "waiting");
        if (d.do === "drop") {
          store.crm.contacts.update(contactId, { stage: "dropped" }, { why: "no reply after the follow-ups", runId });
          ctx.emit({ type: "log", message: `${who}: no reply after the follow-ups, dropped` });
          return save({ state: "dropped", lastCheckedAt: now }, "closed");
        }

        let kind = d.kind;
        if (d.do === "classify") {
          const res = await ctx.llm.chatJson({
            system: "You read replies to LinkedIn outreach and say what the person means. Reply with only a JSON object.",
            user: `${p.replyPrompt}\n\nTheir reply:\n${d.replyText}\n\n${outputInstruction(REPLY_FIELDS)}`,
          });
          const answer = res.ok ? readAnswer(res.value, REPLY_FIELDS) : res;
          if (!answer.ok) { save({ lastCheckedAt: now }); throw new Error(`could not read their reply with the AI: ${answer.error}`); }
          store.crm.contacts.markReplied(accountId, person.profileUrl, { runId });
          o = { ...o, lastReply: { text: d.replyText.slice(0, 2000), at: now, class: answer.value.class, reason: answer.value.reason } };
          const next = afterReply(o, answer.value.class);
          ctx.emit({ type: "log", message: `${who}: replied (${answer.value.class}: ${answer.value.reason})` });
          if (next.do === "stop") {
            if (next.state === "booked") store.crm.contacts.update(contactId, { stage: "meeting" }, { why: "they said they booked", runId });
            if (next.state === "not_interested") store.crm.contacts.update(contactId, { stage: "lost" }, { why: "they said they are not interested", runId });
            return save({ state: next.state, lastCheckedAt: now }, next.state === "needs_you" ? "needsYou" : "closed", { reply: answer.value });
          }
          kind = next.kind;
        }

        if (budget <= 0) { ctx.emit({ type: "log", message: "Message allowance used up; the rest wait for the next run" }); return "stop"; }
        // Left unchecked so the next run, after the link is set, sends it straight away.
        if (kind === "calendar" && !calendarLink) { save({}); throw new Error("they want to talk, but no calendar link is set; add one in Settings and the next run sends it"); }
        const text = renderOutgoing(texts[kind], { ...withFirstName(person), calendarLink });
        const result = await ctx.linkedin.sendMessage(person, text, { intoExistingThread: kind !== "intro" });
        store.actions.record({ accountId, target: person.profileUrl, action: kind === "intro" ? "message" : "followup", status: result.status, detail: result.detail, runId });
        ctx.emit({ type: "log", message: `${who}: ${kind} ${result.status}${result.detail ? ` (${result.detail})` : ""}` });
        const entry = { kind, text, at: now, status: result.status };
        if (result.status === "sent") {
          budget--;
          if (kind === "calendar") store.crm.contacts.update(contactId, { stage: "calendar_sent" }, { why: "calendar link sent", runId });
          else store.crm.contacts.refreshStage(contactId, runId);
          save({ state: sentState(kind), sent: [...(o.sent || []), entry], lastCheckedAt: now }, "sent", { sentKind: kind, text });
          if (budget > 0) await ctx.linkedin.pause(gap);
          return null;
        }
        // An unconfirmed send may have gone out; sending the next one on top of it would double up, so the owner looks first.
        if (result.status === "unverified") return save({ state: "needs_you", sent: [...(o.sent || []), entry], lastCheckedAt: now, note: "a message may have gone out unconfirmed; check the conversation" }, "needsYou");
        if (result.status === "already_messaged") return save({ state: "manual", lastCheckedAt: now, note: "the conversation already had messages" }, "closed");
        save({ lastCheckedAt: now });
        throw new Error(`the ${kind} message was not sent (${result.status}${result.detail ? `: ${result.detail}` : ""}); it is retried on the next look`);
      });
      ctx.emit({ type: "log", message: `${out.sent.length} messages sent, ${out.needsYou.length} need you, ${out.waiting.length} waiting, ${out.closed.length} closed this run; ${notDue} not due for a look yet, ${finished} already finished` });
      return out;
    },
  },

  crmSource: {
    label: "From CRM", group: "CRM", icon: "Database",
    description: "Starts from people already in the CRM for this workflow's account, filtered by stage and tag, newest activity first.",
    input: "trigger", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "stage", label: "Stage", kind: "select", default: "any", options: [["any", "Any stage"], ...STAGE_OPTIONS] },
      { key: "tag", label: "Tag (blank = any)", kind: "text", default: "" },
      { key: "limit", label: "Max people", kind: "number", default: 25 },
    ],
    run: async (_items, p, ctx) => {
      const { rows, total } = ctx.store.crm.contacts.list({ accountId: ctx.accountId, stage: p.stage && p.stage !== "any" ? p.stage : null, tag: String(p.tag || "").trim() || null, limit: Number(p.limit) || 25 });
      ctx.emit({ type: "log", message: `${total} matching people in the CRM, taking ${rows.length}` });
      return { out: rows.map((c) => withFirstName({ ...c.data, kind: "person", profileUrl: c.profileUrl, name: c.name, headline: c.headline, location: c.location, degree: c.degree, crm: { id: c.id, stage: c.stage, tags: c.tags } })) };
    },
  },

  crmUpdate: {
    label: "Update CRM", group: "CRM", icon: "Tags",
    description: "Sets a stage, adds tags or writes a note on each person's CRM record, as if you had done it by hand. Passes everyone on.",
    input: "person", outputs: [{ handle: "out", kind: "same" }],
    params: [
      { key: "stage", label: "Set stage", kind: "select", default: "keep", options: [["keep", "(leave as is)"], ...STAGE_OPTIONS] },
      { key: "addTags", label: "Add tags (comma-separated)", kind: "text", default: "" },
      { key: "note", label: "Note ({{firstName}}, {{evaluation.reason}} and other fields work)", kind: "textarea", default: "" },
    ],
    run: async (people, p, ctx) => {
      const { store, accountId, runId, workflowId } = ctx;
      const out = await eachItem(people, ctx, async (person) => {
        if (!person.profileUrl) throw new Error("has no profile link");
        const contactId = store.crm.contacts.upsert({ accountId, item: person, workflowId, runId });
        const current = store.crm.contacts.find(accountId, person.profileUrl);
        const add = parseTags(p.addTags);
        const updated = store.crm.contacts.update(contactId, { stage: p.stage && p.stage !== "keep" ? p.stage : undefined, tags: add.length ? [...current.tags, ...add] : undefined }, { why: "set by a workflow step", runId });
        const note = render(p.note, withFirstName(person)).trim();
        if (note) store.crm.contacts.addNote(contactId, note, runId);
        return { ...person, crm: { id: updated.id, stage: updated.stage, tags: updated.tags } };
      });
      return { out };
    },
  },
};

// A row that could not be worked this time (thread would not open or read) is tried again later; after FOLLOWUP.MAX_ATTEMPTS it is marked failed so it stops costing page loads.
function retryOrFail(store, row, detail, runId) {
  if (row.failures + 1 >= FOLLOWUP.MAX_ATTEMPTS) store.followups.markFailed(row.id, { text: detail, runId });
  else store.followups.retryLater(row.id, { at: Date.now() + FOLLOWUP.RETRY_HOURS * HOUR, detail, runId });
}

async function sendOne(rowId, ctx) {
  const { store, accountId, runId } = ctx;
  // Re-read: the row may have been cancelled, or answered by Check replies, since the scheduler picked it.
  const row = store.followups.get(rowId);
  if (!row || row.status !== "active" || row.nextDueAt > Date.now()) return null;
  const person = withFirstName({ ...row.data, kind: "person", profileUrl: row.profileUrl, name: row.name || row.data.name });
  const who = person.name || person.profileUrl;
  const cap = Number(row.perDay) || LIMITS.FOLLOWUP_PER_DAY;
  if (store.actions.countSince(accountId, "followup", Date.now() - DAY) >= cap) { ctx.emit({ type: "log", message: `${who}: follow-up allowance of ${cap} a day used up; it waits for the next check` }); return null; }

  const thread = await ctx.linkedin.readThread(person);
  const decision = nextAction({ messages: thread?.messages ?? null, lastSentAt: row.lastSentAt, stopOnReply: row.stopOnReply, stepIndex: row.stepIndex, totalSteps: row.totalSteps });
  if (decision.replied) store.crm.contacts.markReplied(accountId, row.profileUrl, { item: person, runId });
  if (decision.action === "unknown") {
    const detail = `could not read the conversation: ${thread?.reason || "it read empty after a message was sent"}`;
    retryOrFail(store, row, detail, runId);
    throw new Error(detail);
  }
  if (decision.action === "replied") { store.followups.markReplied(row.id, { runId }); ctx.emit({ type: "log", message: `${who}: replied, sequence stopped` }); return null; }
  if (decision.action === "done") { store.followups.markDone(row.id, { runId }); return null; }

  let text;
  // The snapshot will not gain the missing field by waiting, so the sequence stops here rather than retrying.
  try { text = renderOutgoing(row.steps[row.stepIndex].text, withFirstName(person)); } catch (err) { store.followups.markFailed(row.id, { text: err.message, runId }); throw err; }
  if (!text) { store.followups.markFailed(row.id, { text: "the message came out empty", runId }); throw new Error("the follow-up came out empty"); }
  const result = await ctx.linkedin.sendMessage(person, text, { intoExistingThread: true });
  store.actions.record({ accountId, target: row.profileUrl, action: "followup", status: result.status, detail: result.detail, runId });
  ctx.emit({ type: "log", message: `${who}: follow-up ${row.stepIndex + 1} of ${row.totalSteps} ${result.status}${result.detail ? ` (${result.detail})` : ""}` });
  await ctx.linkedin.pause();
  if (result.status === "sent") { store.followups.markSent(row.id, { text, runId }); return { ...person, followedUp: text, followUpStep: row.stepIndex + 1 }; }
  // "failed" means LinkedIn never took the message (the box stayed full or never opened), so trying later is safe; "unverified" may have gone, and a second try could send it twice.
  if (result.status === "failed") retryOrFail(store, row, result.detail || "failed", runId);
  else store.followups.markFailed(row.id, { text: `${result.status}${result.detail ? `: ${result.detail}` : ""}`, runId });
  return null;
}

// One follow-up run: the rows are grouped by the followUp step that enrolled them, so run history shows the work under that step.
async function sendDueFollowUps(rows, ctx) {
  const outputs = {};
  const byNode = new Map();
  for (const r of rows) byNode.set(r.nodeId || "followUp", [...(byNode.get(r.nodeId || "followUp") || []), r]);
  for (const [nodeId, list] of byNode) {
    if (ctx.shouldStop()) break;
    const emit = (e) => ctx.emit({ ...e, nodeId });
    const stepCtx = { ...ctx, nodeId, emit };
    emit({ type: "node.started", inputCount: list.length });
    try {
      const sent = await eachItem(list.map((r) => ({ id: r.id, name: r.name, profileUrl: r.profileUrl })), stepCtx, (r) => sendOne(r.id, stepCtx));
      outputs[nodeId] = { out: sent };
      emit({ type: "node.finished", counts: { out: sent.length } });
    } catch (err) {
      emit({ type: "node.failed", message: err.message });
      throw err;
    }
  }
  return outputs;
}

module.exports = { catalog, sendDueFollowUps };
