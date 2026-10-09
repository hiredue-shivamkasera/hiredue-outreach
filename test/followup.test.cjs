const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSequence, canEnroll, dueAt, hasReplied, nextAction, DAY_MS } = require("../electron/domain/followup.cjs");

test("a sequence keeps its order and reads days as numbers", () => {
  assert.deepEqual(parseSequence([{ afterDays: "3", text: " Hi " }, { afterDays: 7, text: "Again" }]), { steps: [{ afterDays: 3, text: "Hi" }, { afterDays: 7, text: "Again" }] });
});

// A blank message would be sent as nothing, and a zero-day gap would fire the moment someone is enrolled.
test("a sequence with no steps, an empty message or a gap under one day is refused", () => {
  assert.match(parseSequence([]).error, /at least one/);
  assert.match(parseSequence(null).error, /at least one/);
  assert.match(parseSequence([{ afterDays: 3, text: "  " }]).error, /message 1 is empty/);
  assert.match(parseSequence([{ afterDays: 0, text: "x" }]).error, /message 1/);
  assert.match(parseSequence([{ afterDays: "soon", text: "x" }]).error, /message 1/);
});

// A follow-up to someone never messaged is a cold message wearing a disguise, and it skips the message step's checks.
test("only someone this account already messaged can be enrolled", () => {
  assert.deepEqual(canEnroll({ lastSentAt: null, hasActive: false }), { ok: false, reason: "no message from this account to follow up on" });
  assert.deepEqual(canEnroll({ lastSentAt: 1000, hasActive: false }), { ok: true });
});

test("a person already in an active sequence on this account is not enrolled again", () => {
  assert.equal(canEnroll({ lastSentAt: 1000, hasActive: true }).ok, false);
  assert.match(canEnroll({ lastSentAt: 1000, hasActive: true }).reason, /already/);
});

test("a follow-up is due its days after the message before it", () => {
  assert.equal(dueAt(5000, 3), 5000 + 3 * DAY_MS);
});

const mine = (text, at = null) => ({ fromMe: true, text, at });
const theirs = (text, at = null) => ({ fromMe: false, text, at });

test("a message from them after our last one is a reply", () => {
  assert.equal(hasReplied([mine("hi"), theirs("thanks!")], null), true);
  assert.equal(hasReplied([theirs("hello"), mine("hi")], null), false);
});

// LinkedIn groups messages so the order can lie when two land in the same minute; a timestamp after ours settles it.
test("a message from them dated after our last send is a reply even if listed earlier", () => {
  assert.equal(hasReplied([theirs("yes", 2000), mine("hi", 1000)], 1500), true);
  assert.equal(hasReplied([theirs("old", 500), mine("hi", 1000)], 1500), false);
});

// An empty or unread thread must never read as "no reply", or the sequence nags someone who already answered.
test("a thread that could not be read, or reads empty though we sent a message, is unknown", () => {
  assert.equal(hasReplied(null, 1000), null);
  assert.equal(hasReplied([], 1000), null);
});

// Check replies may run on people this account never wrote to; an empty conversation there is a real answer.
test("an empty thread with nothing sent from this account is no reply", () => {
  assert.equal(hasReplied([], null), false);
});

test("a thread where only they wrote counts as a reply", () => {
  assert.equal(hasReplied([theirs("hi there")], 1000), true);
});

test("a reply stops the sequence when stop on reply is on", () => {
  assert.deepEqual(nextAction({ messages: [mine("hi"), theirs("yes")], lastSentAt: 1, stopOnReply: true, stepIndex: 0, totalSteps: 2 }), { action: "replied", replied: true });
});

test("with stop on reply off, a reply is noted and the next message still goes", () => {
  assert.deepEqual(nextAction({ messages: [mine("hi"), theirs("yes")], lastSentAt: 1, stopOnReply: false, stepIndex: 0, totalSteps: 2 }), { action: "send", replied: true });
});

test("no reply sends the next message, and a finished sequence is done", () => {
  assert.deepEqual(nextAction({ messages: [mine("hi")], lastSentAt: 1, stopOnReply: true, stepIndex: 1, totalSteps: 2 }), { action: "send", replied: false });
  assert.deepEqual(nextAction({ messages: [mine("hi")], lastSentAt: 1, stopOnReply: true, stepIndex: 2, totalSteps: 2 }), { action: "done", replied: false });
});

test("an unreadable thread is unknown and sends nothing", () => {
  assert.equal(nextAction({ messages: null, lastSentAt: 1, stopOnReply: true, stepIndex: 0, totalSteps: 2 }).action, "unknown");
  assert.equal(nextAction({ messages: null, lastSentAt: 1, stopOnReply: false, stepIndex: 0, totalSteps: 2 }).action, "unknown");
});
