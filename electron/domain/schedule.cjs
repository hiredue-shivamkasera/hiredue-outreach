// When a Schedule trigger fires next: an interval, inside daily hours, on chosen days, nudged by random jitter. Pure; local time.

const DAYS = { weekdays: [1, 2, 3, 4, 5], everyday: [0, 1, 2, 3, 4, 5, 6], weekends: [0, 6] };
// Below this an interval is a typo, and each fire opens a browser and loads LinkedIn.
const MIN_INTERVAL_MINUTES = 15;

function window(p) {
  const from = Number(p.fromHour) || 0;
  const to = Number(p.toHour) || 0;
  return from < to ? { from, to } : { from: 0, to: 24 };
}

function allowed(date, p) {
  const { from, to } = window(p);
  const days = DAYS[p.days] || DAYS.everyday;
  const hour = date.getHours() + date.getMinutes() / 60;
  return days.includes(date.getDay()) && hour >= from && hour < to;
}

function nextRun(p, after, random = Math.random) {
  const every = Math.max(MIN_INTERVAL_MINUTES, Number(p.everyMinutes) || 60);
  const jitterMs = (Number(p.jitterMinutes) || 0) * 60_000;
  const nudge = () => Math.round((random() * 2 - 1) * jitterMs);
  let t = new Date(after.getTime() + every * 60_000 + nudge());
  if (t <= after) t = new Date(after.getTime() + 60_000);
  if (allowed(t, p)) return t;

  const { from } = window(p);
  const days = DAYS[p.days] || DAYS.everyday;
  for (let i = 0; i < 8; i++) {
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, from, 0, 0);
    if (start < t || !days.includes(start.getDay())) continue;
    // Only push later at the window's start, so a run never lands before the hour the person set.
    return new Date(start.getTime() + Math.abs(nudge()) / 2);
  }
  return null;
}

module.exports = { nextRun };
