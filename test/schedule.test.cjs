const test = require("node:test");
const assert = require("node:assert/strict");
const { nextRun } = require("../electron/domain/schedule.cjs");

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m); // October 2026: the 8th is a Thursday, the 10th a Saturday
const noJitter = () => 0.5;
const base = { everyMinutes: 120, fromHour: 9, toHour: 19, days: "weekdays", jitterMinutes: 0 };

test("inside the window the next run is one interval later", () => {
  assert.deepEqual(nextRun(base, at(8, 10), noJitter), at(8, 12));
});

test("a run that would land after the window moves to the next allowed morning", () => {
  assert.deepEqual(nextRun(base, at(8, 18), noJitter), at(9, 9));
});

test("weekdays skip Saturday and Sunday", () => {
  assert.deepEqual(nextRun(base, at(9, 18), noJitter), at(12, 9));
});

test("before the window opens the next run is the window's start", () => {
  assert.deepEqual(nextRun({ ...base, everyMinutes: 30 }, at(8, 6), noJitter), at(8, 9));
});

// Firing at the same minute every day is a pattern a person would not make; jitter moves it by up to the set minutes either way.
test("jitter moves the run by at most the set minutes", () => {
  const p = { ...base, jitterMinutes: 10 };
  assert.deepEqual(nextRun(p, at(8, 10), () => 0), at(8, 11, 50));
  assert.deepEqual(nextRun(p, at(8, 10), () => 1), at(8, 12, 10));
});

test("a window with from at or after to means all day", () => {
  assert.deepEqual(nextRun({ ...base, fromHour: 0, toHour: 0, days: "everyday" }, at(10, 23), noJitter), at(11, 1));
});

// A typo of 0 or 1 minute must not open the browser every tick.
test("the interval never drops below 15 minutes", () => {
  assert.deepEqual(nextRun({ ...base, everyMinutes: 1 }, at(8, 10), noJitter), at(8, 10, 15));
});

test("the next run is always after the given time", () => {
  const p = { ...base, everyMinutes: 15, jitterMinutes: 60 };
  for (let i = 0; i < 50; i++) assert.ok(nextRun(p, at(8, 10), Math.random) > at(8, 10));
});
