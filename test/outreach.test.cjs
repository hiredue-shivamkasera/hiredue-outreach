const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldCheck, afterProfile, afterThread, afterReply, sentState, nextActionOf, STATES, isOurs } = require("../electron/domain/outreach.cjs");

const H = 3600_000, D = 24 * H;
const T = 1_800_000_000_000;
const params = { cadenceDays: 2, checkEveryHours: 6, giveUpInviteDays: 21, followUps: ["fu one", "fu two"] };
const me = (text, at) => ({ fromMe: true, text, at });
const them = (text, at) => ({ fromMe: false, text, at });

test("every state has a label and terminal states are marked", () => {
  for (const s of STATES) assert.ok(s.id && s.label && typeof s.terminal === "boolean");
  assert.ok(STATES.find((s) => s.id === "booked").terminal);
  assert.ok(!STATES.find((s) => s.id === "intro_sent").terminal);
});

// Opening a profile or a thread for every person on every run is what gets an account noticed; a recent look is enough.
test("a person checked within the last few hours is not checked again", () => {
  assert.equal(shouldCheck({ state: "intro_sent", lastCheckedAt: T - 2 * H }, T, params), false);
  assert.equal(shouldCheck({ state: "intro_sent", lastCheckedAt: T - 7 * H }, T, params), true);
  assert.equal(shouldCheck(null, T, params), true);
});

test("a person in a finished state is never checked again", () => {
  for (const state of ["booked", "dropped", "manual", "needs_you", "not_interested", "invite_stale"]) assert.equal(shouldCheck({ state, lastCheckedAt: 0 }, T, params), false);
});

test("an accepted invite moves the person to connected", () => {
  assert.equal(afterProfile({ state: "invited", invitedAt: T - D }, "1st", T, params).state, "connected");
});

test("an invite still pending keeps waiting until it is too old, then is given up", () => {
  assert.equal(afterProfile({ state: "invited", invitedAt: T - 3 * D }, "2nd", T, params).state, "invited");
  assert.equal(afterProfile({ state: "invited", invitedAt: T - 22 * D }, "2nd", T, params).state, "invite_stale");
});

// Without a degree the profile read failed; giving up or moving on would both be guesses.
test("an unreadable degree leaves the invite as it was", () => {
  assert.equal(afterProfile({ state: "invited", invitedAt: T - 30 * D }, null, T, params).state, "invited");
});

test("a new connection with an empty conversation gets the intro", () => {
  assert.deepEqual(afterThread({ state: "connected", sent: [] }, [], T, params), { do: "send", kind: "intro" });
});

// A thread that reads empty after we sent into it means the read failed; acting on it could double-send.
test("an empty conversation after we already sent something is unknown, not silence", () => {
  assert.equal(afterThread({ state: "intro_sent", sent: [{ kind: "intro", text: "hello", at: T - 3 * D }] }, [], T, params).do, "unknown");
  assert.equal(afterThread({ state: "intro_sent", sent: [] }, null, T, params).do, "unknown");
});

test("no reply after the cadence sends follow-up one, then two, then drops", () => {
  const intro = { kind: "intro", text: "Hi Asha, intro text here", at: T - 3 * D };
  assert.deepEqual(afterThread({ state: "intro_sent", sent: [intro] }, [me(intro.text, intro.at)], T, params), { do: "send", kind: "followup1" });
  const fu1 = { kind: "followup1", text: "fu one", at: T - 2.5 * D };
  assert.deepEqual(afterThread({ state: "followup1_sent", sent: [intro, fu1] }, [me(intro.text, intro.at), me("fu one", fu1.at)], T, params), { do: "send", kind: "followup2" });
  const fu2 = { kind: "followup2", text: "fu two", at: T - 2.1 * D };
  assert.deepEqual(afterThread({ state: "followup2_sent", sent: [intro, fu1, fu2] }, [me(intro.text, intro.at), me("fu one", fu1.at), me("fu two", fu2.at)], T, params), { do: "drop" });
});

test("before the cadence has passed the person waits, with the time it will be due", () => {
  const intro = { kind: "intro", text: "Hi Asha, intro", at: T - 1 * D };
  assert.deepEqual(afterThread({ state: "intro_sent", sent: [intro] }, [me(intro.text, intro.at)], T, params), { do: "wait", until: intro.at + 2 * D });
});

test("with only one follow-up configured, the person is dropped after it", () => {
  const p = { ...params, followUps: ["fu one"] };
  const sent = [{ kind: "intro", text: "intro", at: T - 5 * D }, { kind: "followup1", text: "fu one", at: T - 3 * D }];
  assert.deepEqual(afterThread({ state: "followup1_sent", sent }, [me("intro", sent[0].at), me("fu one", sent[1].at)], T, p), { do: "drop" });
});

test("a reply after our last message is passed to the reply reader with everything they wrote since", () => {
  const sent = [{ kind: "intro", text: "Hi Asha, intro", at: T - 3 * D }];
  const r = afterThread({ state: "intro_sent", sent }, [me(sent[0].text, sent[0].at), them("Sure, happy to chat", T - D), them("When works?", T - D + 1)], T, params);
  assert.deepEqual(r, { do: "classify", replyText: "Sure, happy to chat\nWhen works?" });
});

// The owner answering by hand means the conversation is theirs now; another automated message would talk over them.
test("a message from the owner that the automation did not send hands the person over", () => {
  const sent = [{ kind: "intro", text: "Hi Asha, intro", at: T - 3 * D }];
  const r = afterThread({ state: "intro_sent", sent }, [me(sent[0].text, sent[0].at), them("tell me more", T - 2 * D), me("Sure! Here is a quick video", T - D)], T, params);
  assert.deepEqual(r, { do: "manual" });
});

test("someone who wrote first after connecting is read, not sent an intro over the top", () => {
  assert.equal(afterThread({ state: "connected", sent: [] }, [them("Thanks for connecting!", T - H)], T, params).do, "classify");
});

test("the owner having messaged them before the automation hands the person over", () => {
  assert.deepEqual(afterThread({ state: "connected", sent: [] }, [me("Hey, long time!", T - D)], T, params), { do: "manual" });
});

test("isOurs matches a sent text despite whitespace and case differences, and not a different text", () => {
  const sent = [{ text: "Hi Asha,\n\nWe launched HireDue a month ago." }];
  assert.equal(isOurs("hi asha, we launched hiredue a month ago.", sent), true);
  assert.equal(isOurs("Something else entirely", sent), false);
});

test("an interested reply gets the calendar link once; a second interested reply needs the owner", () => {
  assert.deepEqual(afterReply({ state: "intro_sent" }, "interested"), { do: "send", kind: "calendar" });
  assert.deepEqual(afterReply({ state: "calendar_sent" }, "interested"), { do: "stop", state: "needs_you" });
});

test("replies that close the conversation set the final state", () => {
  assert.deepEqual(afterReply({ state: "calendar_sent" }, "booked"), { do: "stop", state: "booked" });
  assert.deepEqual(afterReply({ state: "followup1_sent" }, "not_interested"), { do: "stop", state: "not_interested" });
  assert.deepEqual(afterReply({ state: "intro_sent" }, "other"), { do: "stop", state: "needs_you" });
});

// An unreadable classification must never become a calendar link or a "not interested"; the owner reads it.
test("an unknown reply class hands the person to the owner", () => {
  assert.deepEqual(afterReply({ state: "intro_sent" }, undefined), { do: "stop", state: "needs_you" });
});

test("sentState names the state after each kind of message", () => {
  assert.equal(sentState("intro"), "intro_sent");
  assert.equal(sentState("followup2"), "followup2_sent");
  assert.equal(sentState("calendar"), "calendar_sent");
});

test("nextActionOf says what happens next and when", () => {
  assert.deepEqual(nextActionOf({ state: "invited", lastCheckedAt: T }, params), { kind: "check_accepted", at: T + 6 * H });
  assert.deepEqual(nextActionOf({ state: "intro_sent", lastCheckedAt: T, sent: [{ kind: "intro", at: T - D }] }, params), { kind: "followup1", at: T + D });
  assert.deepEqual(nextActionOf({ state: "followup2_sent", lastCheckedAt: T, sent: [{ kind: "followup2", at: T }] }, params), { kind: "drop", at: T + 2 * D });
  assert.deepEqual(nextActionOf({ state: "calendar_sent", lastCheckedAt: T, sent: [] }, params), { kind: "check_booked", at: T + 6 * H });
  assert.equal(nextActionOf({ state: "booked" }, params), null);
});
