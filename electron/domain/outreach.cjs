// The outreach sequence for one person: invite accepted → intro → follow-ups → drop, and what a reply leads to. Pure; the Outreach sequence step reads LinkedIn and applies these answers.

const H = 3600_000;
const D = 24 * H;

// terminal: the automation never touches the person again until the owner resumes it.
const STATES = [
  { id: "invited", label: "Invite sent", terminal: false },
  { id: "connected", label: "Connected, intro due", terminal: false },
  { id: "intro_sent", label: "Intro sent", terminal: false },
  { id: "followup1_sent", label: "Follow-up 1 sent", terminal: false },
  { id: "followup2_sent", label: "Follow-up 2 sent", terminal: false },
  { id: "calendar_sent", label: "Calendar link sent", terminal: false },
  { id: "needs_you", label: "Replied, needs you", terminal: true },
  { id: "manual", label: "Handled by you", terminal: true },
  { id: "booked", label: "Meeting booked", terminal: true },
  { id: "not_interested", label: "Not interested", terminal: true },
  { id: "dropped", label: "No reply, dropped", terminal: true },
  { id: "invite_stale", label: "Invite never accepted", terminal: true },
];
const BY_ID = new Map(STATES.map((s) => [s.id, s]));
const isTerminal = (state) => !!BY_ID.get(state)?.terminal;

const SENT_STATE = { intro: "intro_sent", followup1: "followup1_sent", followup2: "followup2_sent", calendar: "calendar_sent" };
const sentState = (kind) => SENT_STATE[kind];

// After each automated message, which one comes next if they stay silent.
const NEXT_IF_SILENT = { intro_sent: 0, followup1_sent: 1, followup2_sent: 2 };
function silentNext(state, followUps) {
  const i = NEXT_IF_SILENT[state];
  if (i === undefined) return null;
  return followUps[i] ? `followup${i + 1}` : "drop";
}

const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

// LinkedIn re-wraps and sometimes shortens message text in the thread, so a sent text counts as ours when either one starts with the other's opening words.
function isOurs(text, sent = []) {
  const a = norm(text);
  if (!a) return false;
  return sent.some((s) => { const b = norm(s.text); return !!b && (a === b || a.startsWith(b.slice(0, 60)) || b.startsWith(a.slice(0, 60))); });
}

function shouldCheck(outreach, now, { checkEveryHours }) {
  if (!outreach) return true;
  if (isTerminal(outreach.state)) return false;
  return !outreach.lastCheckedAt || now - outreach.lastCheckedAt >= Number(checkEveryHours) * H;
}

function afterProfile(outreach, degree, now, { giveUpInviteDays }) {
  const state = outreach?.state || "invited";
  if (state !== "invited") return { state };
  if (/^1st/i.test(String(degree || ""))) return { state: "connected" };
  if (!degree) return { state };
  if (outreach?.invitedAt && now - outreach.invitedAt > Number(giveUpInviteDays) * D) return { state: "invite_stale" };
  return { state };
}

function afterThread(outreach, messages, now, { cadenceDays, followUps = [] }) {
  const sent = outreach?.sent || [];
  const state = outreach?.state;
  if (!Array.isArray(messages)) return { do: "unknown" };
  if (!messages.length) return sent.length || state !== "connected" ? { do: "unknown" } : { do: "send", kind: "intro" };

  const lastMine = messages.map((m) => m.fromMe).lastIndexOf(true);
  const theirsSince = messages.slice(lastMine + 1).filter((m) => !m.fromMe);
  if (theirsSince.length) return { do: "classify", replyText: theirsSince.map((m) => m.text).join("\n") };
  if (lastMine >= 0 && !isOurs(messages[lastMine].text, sent)) return { do: "manual" };

  const next = silentNext(state, followUps.filter((f) => String(f || "").trim()));
  if (!next) return { do: "wait", until: null };
  const due = (sent[sent.length - 1]?.at ?? now) + Number(cadenceDays) * D;
  if (now < due) return { do: "wait", until: due };
  return next === "drop" ? { do: "drop" } : { do: "send", kind: next };
}

// replyClass comes from the AI; anything it could not place goes to the owner rather than becoming a calendar link or a "no".
function afterReply(outreach, replyClass) {
  if (replyClass === "booked") return { do: "stop", state: "booked" };
  if (replyClass === "not_interested") return { do: "stop", state: "not_interested" };
  if (replyClass === "interested" && outreach?.state !== "calendar_sent") return { do: "send", kind: "calendar" };
  return { do: "stop", state: "needs_you" };
}

function nextActionOf(outreach, { cadenceDays, checkEveryHours, followUps = [] }) {
  if (!outreach || isTerminal(outreach.state)) return null;
  const checkAt = (outreach.lastCheckedAt || 0) + Number(checkEveryHours) * H;
  if (outreach.state === "invited") return { kind: "check_accepted", at: checkAt };
  if (outreach.state === "connected") return { kind: "intro", at: checkAt };
  if (outreach.state === "calendar_sent") return { kind: "check_booked", at: checkAt };
  const next = silentNext(outreach.state, followUps.filter((f) => String(f || "").trim()));
  const lastAt = outreach.sent?.[outreach.sent.length - 1]?.at ?? outreach.lastCheckedAt ?? 0;
  return next ? { kind: next, at: lastAt + Number(cadenceDays) * D } : null;
}

const stateLabel = (state) => BY_ID.get(state)?.label || state;

module.exports = { STATES, isTerminal, stateLabel, sentState, isOurs, shouldCheck, afterProfile, afterThread, afterReply, nextActionOf };
