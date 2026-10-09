// The two rules that gate outreach: whether an AI answer qualifies someone, and how many more invites or messages an account may send. Pure.

// true or false for a readable answer, null when the model's answer cannot be trusted either way.
function qualifies(answer, minScore) {
  if (!answer || typeof answer.qualified !== "boolean") return null;
  const score = Number(answer.score);
  if (answer.score === undefined || answer.score === null || answer.score === "" || !Number.isFinite(score)) return null;
  return answer.qualified && score >= Number(minScore || 0);
}

function remainingBudget({ usedToday, perDay, usedThisWeek, perWeek }) {
  const day = Number(perDay) - usedToday;
  const week = perWeek == null || perWeek === "" ? Infinity : Number(perWeek) - usedThisWeek;
  return Math.max(0, Math.min(day, week));
}

function runAllowance({ perRun, jitter = 0, random = Math.random }) {
  if (perRun === undefined || perRun === null || perRun === "") return Infinity;
  const j = Math.max(0, Number(jitter) || 0);
  return Math.max(0, Math.round(Number(perRun) + (random() * 2 - 1) * j));
}

module.exports = { qualifies, remainingBudget, runAllowance };
