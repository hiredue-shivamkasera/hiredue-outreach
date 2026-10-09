// Whether an item passes a Condition step's rules, and whether those rules are well formed. Pure. A rule on a field the item does not have is false, except isEmpty, so missing data never reads as a pass.

const OPS = ["equals", "notEquals", "contains", "notContains", "greaterThan", "lessThan", "atLeast", "atMost", "isTrue", "isFalse", "isEmpty", "isNotEmpty"];
const NO_VALUE = new Set(["isTrue", "isFalse", "isEmpty", "isNotEmpty"]);
const NUMERIC = new Set(["greaterThan", "lessThan", "atLeast", "atMost"]);

const valueAt = (item, path) => String(path).split(".").reduce((v, k) => (v == null ? undefined : v[k]), item);

// "70" typed into a settings box and 70 from the model are the same number; "1st" and "" are not numbers.
function asNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

const isEmpty = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const lower = (v) => String(v).trim().toLowerCase();

function same(actual, expected) {
  const a = asNumber(actual), b = asNumber(expected);
  return a !== null && b !== null ? a === b : lower(actual) === lower(expected);
}

const contains = (actual, expected) => (Array.isArray(actual) ? actual.some((x) => lower(x).includes(lower(expected))) : lower(actual).includes(lower(expected)));

function check(rule, item) {
  const actual = valueAt(item, rule.field);
  if (rule.op === "isEmpty") return isEmpty(actual);
  if (actual == null) return false;
  const a = asNumber(actual), b = asNumber(rule.value);
  switch (rule.op) {
    case "equals": return same(actual, rule.value);
    case "notEquals": return !same(actual, rule.value);
    case "contains": return contains(actual, rule.value);
    case "notContains": return !contains(actual, rule.value);
    case "greaterThan": return a !== null && b !== null && a > b;
    case "lessThan": return a !== null && b !== null && a < b;
    case "atLeast": return a !== null && b !== null && a >= b;
    case "atMost": return a !== null && b !== null && a <= b;
    case "isTrue": return actual === true || lower(actual) === "true";
    case "isFalse": return actual === false || lower(actual) === "false";
    case "isNotEmpty": return !isEmpty(actual);
    default: return false;
  }
}

function evaluate(spec, item) {
  const results = spec.rules.map((r) => check(r, item));
  return spec.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

function ruleProblems(spec) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.rules)) return ["The rules are missing"];
  const problems = [];
  if (spec.match !== "all" && spec.match !== "any") problems.push(`Match must be "all" or "any", not "${spec.match}"`);
  if (!spec.rules.length) problems.push("Add at least one rule");
  spec.rules.forEach((r, i) => {
    const field = String(r?.field || "").trim();
    const name = field ? `Rule ${i + 1} (${field})` : `Rule ${i + 1}`;
    if (!field) problems.push(`${name} has no field`);
    if (!OPS.includes(r?.op)) { problems.push(`${name} has unknown test "${r?.op}"`); return; }
    if (NO_VALUE.has(r.op)) return;
    if (r.value == null || String(r.value).trim() === "") problems.push(`${name} needs a value to compare with`);
    else if (NUMERIC.has(r.op) && asNumber(r.value) === null) problems.push(`${name} compares with "${r.value}", which is not a number`);
  });
  return problems;
}

module.exports = { evaluate, ruleProblems, valueAt, OPS, NO_VALUE };
