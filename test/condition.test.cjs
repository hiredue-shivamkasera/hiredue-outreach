const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, ruleProblems, OPS } = require("../electron/domain/condition.cjs");

const lead = { name: "Asha Rao", headline: "Founder at Acme Analytics", degree: "2nd", ai: { fit_score: 82, is_decision_maker: true, reason: "" }, evaluation: { score: "64" }, tags: [] };
const one = (field, op, value) => ({ match: "all", rules: [{ field, op, value }] });
const check = (field, op, value, item = lead) => evaluate(one(field, op, value), item);

test("dotted paths reach nested fields", () => {
  assert.equal(check("ai.fit_score", "atLeast", 70), true);
  assert.equal(check("ai.fit_score", "atLeast", 90), false);
});

// A threshold typed into a text box arrives as "70"; comparing it as text would put "100" below "70".
test("numbers compare as numbers when both sides are numeric", () => {
  assert.equal(check("evaluation.score", "greaterThan", "100"), false);
  assert.equal(check("evaluation.score", "lessThan", "100"), true);
  assert.equal(check("evaluation.score", "equals", 64), true);
  assert.equal(check("evaluation.score", "equals", "64.0"), true);
  assert.equal(check("ai.fit_score", "atMost", "82"), true);
  assert.equal(check("ai.fit_score", "greaterThan", 82), false);
});

test("a number comparison on text is false rather than a guess", () => {
  assert.equal(check("degree", "greaterThan", 1), false);
  assert.equal(check("ai.fit_score", "atLeast", "high"), false);
});

test("text operators ignore case", () => {
  assert.equal(check("headline", "contains", "FOUNDER"), true);
  assert.equal(check("headline", "notContains", "student"), true);
  assert.equal(check("degree", "equals", "2ND"), true);
  assert.equal(check("degree", "notEquals", "1st"), true);
});

test("isTrue and isFalse check the value itself", () => {
  assert.equal(check("ai.is_decision_maker", "isTrue"), true);
  assert.equal(check("ai.is_decision_maker", "isFalse"), false);
  assert.equal(check("ai.is_decision_maker", "isTrue", undefined, { ai: { is_decision_maker: false } }), false);
  assert.equal(check("headline", "isTrue"), false);
});

// A rule on a field the item does not have cannot be true, or "notContains spam" would pass people we know nothing about.
test("a missing field fails every rule except isEmpty", () => {
  for (const op of OPS.filter((o) => o !== "isEmpty")) assert.equal(check("ai.missing", op, "x"), false, op);
  assert.equal(check("ai.missing", "isEmpty"), true);
  assert.equal(check("nothing.at.all", "isEmpty"), true);
});

test("empty strings and empty lists count as empty", () => {
  assert.equal(check("ai.reason", "isEmpty"), true);
  assert.equal(check("tags", "isEmpty"), true);
  assert.equal(check("headline", "isNotEmpty"), true);
});

test("match all needs every rule, match any needs one", () => {
  const rules = [{ field: "ai.fit_score", op: "atLeast", value: 70 }, { field: "degree", op: "equals", value: "1st" }];
  assert.equal(evaluate({ match: "all", rules }, lead), false);
  assert.equal(evaluate({ match: "any", rules }, lead), true);
});

test("a valid rule set has no problems", () => {
  assert.deepEqual(ruleProblems({ match: "all", rules: [{ field: "ai.fit_score", op: "atLeast", value: 70 }, { field: "ai.is_decision_maker", op: "isTrue" }] }), []);
});

// A broken rule would route every item down one branch without saying why, so the editor must show it before the run.
test("broken rule sets are reported", () => {
  assert.ok(ruleProblems(null).length);
  assert.ok(ruleProblems({ match: "all", rules: [] }).length);
  assert.match(ruleProblems({ match: "most", rules: [{ field: "a", op: "isTrue" }] }).join(), /most/);
  assert.match(ruleProblems(one("", "isTrue")).join(), /field/i);
  assert.match(ruleProblems(one("score", "roughly", 1)).join(), /roughly/);
  assert.match(ruleProblems(one("score", "atLeast", "")).join(), /score/);
  assert.match(ruleProblems(one("score", "atLeast", "high")).join(), /number/);
  assert.match(ruleProblems(one("headline", "contains", " ")).join(), /headline/);
});
