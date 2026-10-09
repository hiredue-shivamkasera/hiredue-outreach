// The rules of a follow-up sequence: what a valid sequence is, who may be enrolled, when the next message is due, and what to do with a conversation once it is read. Pure; it never reads LinkedIn or the database.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseSequence(steps) {
  if (!Array.isArray(steps) || !steps.length) return { error: "add at least one follow-up message" };
  const out = [];
  for (const [i, s] of steps.entries()) {
    const afterDays = Number(s?.afterDays);
    const text = String(s?.text ?? "").trim();
    if (!text) return { error: `follow-up message ${i + 1} is empty` };
    if (!Number.isFinite(afterDays) || afterDays < 1) return { error: `follow-up message ${i + 1} needs a gap of at least 1 day` };
    out.push({ afterDays, text });
  }
  return { steps: out };
}

function canEnroll({ lastSentAt, hasActive }) {
  if (lastSentAt == null) return { ok: false, reason: "no message from this account to follow up on" };
  if (hasActive) return { ok: false, reason: "already in an active follow-up sequence from this account" };
  return { ok: true };
}

const dueAt = (fromMs, afterDays) => fromMs + Number(afterDays) * DAY_MS;

// true, false, or null when the thread does not let anyone tell; a thread that reads empty after we sent into it means the reading failed, not silence.
function hasReplied(messages, lastSentAt) {
  if (!Array.isArray(messages)) return null;
  if (!messages.length) return lastSentAt == null ? false : null;
  const lastMine = messages.map((m) => m.fromMe).lastIndexOf(true);
  if (messages.slice(lastMine + 1).some((m) => !m.fromMe)) return true;
  if (lastSentAt != null && messages.some((m) => !m.fromMe && Number.isFinite(m.at) && m.at > lastSentAt)) return true;
  return false;
}

function nextAction({ messages, lastSentAt, stopOnReply, stepIndex, totalSteps }) {
  const replied = hasReplied(messages, lastSentAt);
  if (replied === null) return { action: "unknown", replied: null };
  if (replied && stopOnReply) return { action: "replied", replied };
  return { action: stepIndex >= totalSteps ? "done" : "send", replied };
}

module.exports = { DAY_MS, parseSequence, canEnroll, dueAt, hasReplied, nextAction };
