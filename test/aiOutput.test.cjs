const test = require("node:test");
const assert = require("node:assert/strict");
const { outputInstruction, readAnswer, fieldProblems } = require("../electron/domain/aiOutput.cjs");

const fields = [
  { name: "fit_score", type: "number", description: "0-100 fit" },
  { name: "is_decision_maker", type: "boolean", description: "takes vendor calls" },
  { name: "seniority", type: "choice", choices: "junior, Senior, Founder", description: "their level" },
  { name: "reason", type: "text", description: "one sentence" },
];

const good = { fit_score: 82, is_decision_maker: true, seniority: "Founder", reason: "Runs a B2B agency" };

test("the instruction names every field with its type and description", () => {
  const text = outputInstruction(fields);
  for (const f of fields) assert.match(text, new RegExp(`"${f.name}"`));
  assert.match(text, /true or false/);
  assert.match(text, /"junior", "Senior", "Founder"/);
  assert.match(text, /0-100 fit/);
});

test("a complete, well-typed answer is read as is", () => {
  assert.deepEqual(readAnswer(good, fields), { ok: true, value: good });
});

// Models often quote numbers; "82" is still a readable score, and later conditions compare it as a number.
test("a numeric string is accepted for a number field and stored as a number", () => {
  const r = readAnswer({ ...good, fit_score: " 82 " }, fields);
  assert.equal(r.ok, true);
  assert.equal(r.value.fit_score, 82);
});

test("a non-numeric number field is an error naming the field", () => {
  const r = readAnswer({ ...good, fit_score: "high" }, fields);
  assert.equal(r.ok, false);
  assert.match(r.error, /fit_score/);
});

// "yes" or "false" as a string is a guess about what the model meant; reading it as a verdict would let a typo send invites.
test("a boolean field takes only true or false", () => {
  for (const bad of ["true", "yes", 1, null]) {
    const r = readAnswer({ ...good, is_decision_maker: bad }, fields);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.match(r.error, /is_decision_maker/);
  }
  assert.equal(readAnswer({ ...good, is_decision_maker: false }, fields).value.is_decision_maker, false);
});

test("a choice matches case-insensitively and is stored with the listed spelling", () => {
  assert.equal(readAnswer({ ...good, seniority: "senior" }, fields).value.seniority, "Senior");
  const r = readAnswer({ ...good, seniority: "manager" }, fields);
  assert.equal(r.ok, false);
  assert.match(r.error, /seniority/);
});

test("an empty text field is an error, not an empty answer", () => {
  const r = readAnswer({ ...good, reason: "   " }, fields);
  assert.equal(r.ok, false);
  assert.match(r.error, /reason/);
});

// Filling a missing score with 0 would read as "a poor fit" when the truth is "the model did not say".
test("a missing field is an error and nothing is filled in", () => {
  const { fit_score, ...rest } = good;
  const r = readAnswer(rest, fields);
  assert.equal(r.ok, false);
  assert.match(r.error, /fit_score.*missing/);
  assert.equal(r.value, undefined);
});

test("fields the spec does not name are dropped", () => {
  assert.deepEqual(Object.keys(readAnswer({ ...good, extra: 1 }, fields).value).sort(), Object.keys(good).sort());
});

test("an answer that is not an object is an error", () => {
  assert.equal(readAnswer(null, fields).ok, false);
  assert.equal(readAnswer([good], fields).ok, false);
});

test("a well-formed field list has no problems", () => {
  assert.deepEqual(fieldProblems(fields), []);
});

// Field names end up in {{ai.name}} templates and condition paths, so they must be plain identifiers and unique.
test("bad field lists are reported", () => {
  assert.ok(fieldProblems([]).length);
  assert.ok(fieldProblems("score").length);
  assert.match(fieldProblems([{ name: "", type: "text" }]).join(), /name/i);
  assert.match(fieldProblems([{ name: "fit score", type: "text" }]).join(), /fit score/);
  assert.match(fieldProblems([{ name: "a", type: "text" }, { name: "a", type: "number" }]).join(), /twice/);
  assert.match(fieldProblems([{ name: "a", type: "date" }]).join(), /date/);
  assert.match(fieldProblems([{ name: "level", type: "choice", choices: " , " }]).join(), /level/);
});
