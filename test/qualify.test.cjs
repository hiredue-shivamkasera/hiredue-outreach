const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifies, remainingBudget, runAllowance } = require("../electron/domain/qualify.cjs");

test("a qualified answer at or above the minimum score passes", () => {
  assert.equal(qualifies({ qualified: true, score: 70 }, 70), true);
});

// The model sometimes says yes with a weak score; the score threshold is the user's dial, so it wins.
test("a yes with a score under the minimum fails", () => {
  assert.equal(qualifies({ qualified: true, score: 55 }, 70), false);
});

test("a no fails whatever the score", () => {
  assert.equal(qualifies({ qualified: false, score: 95 }, 70), false);
});

// A malformed answer must not be read as a no, or a flaky model silently discards good leads.
test("an answer missing the verdict or the score is unreadable, not a no", () => {
  assert.equal(qualifies({ score: 90 }, 70), null);
  assert.equal(qualifies({ qualified: "yes", score: 90 }, 70), null);
  assert.equal(qualifies({ qualified: true }, 70), null);
  assert.equal(qualifies(null, 70), null);
});

test("a score given as a numeric string is accepted", () => {
  assert.equal(qualifies({ qualified: true, score: "82" }, 70), true);
});

test("remaining budget is the tighter of the day and week allowances", () => {
  assert.equal(remainingBudget({ usedToday: 5, perDay: 20, usedThisWeek: 95, perWeek: 100 }), 5);
  assert.equal(remainingBudget({ usedToday: 18, perDay: 20, usedThisWeek: 10, perWeek: 100 }), 2);
});

test("an overspent budget is zero, never negative", () => {
  assert.equal(remainingBudget({ usedToday: 25, perDay: 20, usedThisWeek: 0, perWeek: 100 }), 0);
});

test("a blank week limit means only the day limit applies", () => {
  assert.equal(remainingBudget({ usedToday: 3, perDay: 10, usedThisWeek: 500, perWeek: null }), 7);
});

// A fixed number of invites at the same times every day is a pattern; the jitter moves it a little each run.
test("the per-run allowance varies by up to the jitter either way", () => {
  assert.equal(runAllowance({ perRun: 8, jitter: 2, random: () => 0 }), 6);
  assert.equal(runAllowance({ perRun: 8, jitter: 2, random: () => 0.999 }), 10);
  assert.equal(runAllowance({ perRun: 8, jitter: 2, random: () => 0.5 }), 8);
});

test("a blank per-run setting means no per-run limit, and the allowance is never negative", () => {
  assert.equal(runAllowance({ perRun: "", jitter: 2, random: () => 0 }), Infinity);
  assert.equal(runAllowance({ perRun: 1, jitter: 5, random: () => 0 }), 0);
});
