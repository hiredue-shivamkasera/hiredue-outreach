// The loops every step is built from: one item at a time with per-item failure, and the skip-cap-record-verify sequence for anything other people can see. Shared by nodes.cjs and nodes.crm.cjs.

const { firstName } = require("./domain/text.cjs");
const { remainingBudget, runAllowance } = require("./domain/qualify.cjs");
const { NotLoggedIn, InviteLimitReached } = require("./adapters/linkedin.adapter.cjs");

const DAY = 24 * 60 * 60 * 1000;
const withFirstName = (p) => ({ ...p, firstName: p.firstName || firstName(p.name) });

// One person failing (a deleted profile, a slow page) costs that person only. A lost session ends the run, and so do three failures on the first three items, which means the step itself is broken (a bad API key, stale selectors) rather than the people.
async function eachItem(items, ctx, fn) {
  const out = [];
  let failedFromStart = 0;
  for (const [i, item] of items.entries()) {
    if (ctx.shouldStop()) { ctx.emit({ type: "log", message: `Stopped with ${items.length - i} left` }); break; }
    try {
      const result = await fn(item, i);
      failedFromStart = -Infinity;
      if (result === "stop") break;
      if (result) out.push(result);
    } catch (err) {
      if (err instanceof NotLoggedIn) throw err;
      ctx.emit({ type: "item.failed", message: `${item.name || item.authorName || "item"}: ${err.message}`, profileUrl: item.profileUrl });
      if (++failedFromStart === 3) throw new Error(`The first three items all failed, so this step is stopping. Last error: ${err.message}`);
    }
  }
  return out;
}

const label = (item) => item.name || item.authorName || item.pageUrl || item.postUrl || "item";
const postKey = (item) => item.postUrn || item.postUrl || null;

// Shared by every step that does something other people can see on LinkedIn: skip what this account already did, stop at the allowance, record every attempt, and pass on only what LinkedIn confirmed.
// perRun (± perRunJitter) caps one run on top of the day and week caps; gapSeconds [min, max] is the wait after each one LinkedIn accepted.
async function actOnEach(items, ctx, { action, noun, perDay, perWeek = null, perRun = null, perRunJitter = 0, gapSeconds = null, targetOf, act }) {
  const { store, accountId, runId } = ctx;
  const used = (ms) => store.actions.countSince(accountId, action, Date.now() - ms);
  const left = remainingBudget({ usedToday: used(DAY), perDay, usedThisWeek: perWeek == null ? 0 : used(7 * DAY), perWeek });
  const thisRun = runAllowance({ perRun, jitter: perRunJitter });
  let budget = Math.min(left, thisRun);
  ctx.emit({ type: "log", message: `${noun} allowance: ${budget} this run (${left} left in the day and week caps${Number.isFinite(thisRun) ? `, ${thisRun} for this run` : ""})` });
  const gap = gapSeconds && Number(gapSeconds[1]) > 0 ? [Number(gapSeconds[0]) * 1000, Number(gapSeconds[1]) * 1000] : null;
  return eachItem(items, ctx, async (item) => {
    const target = targetOf(item);
    if (!target) throw new Error("has no LinkedIn link to act on");
    if (store.actions.alreadyDone(accountId, target, action)) { ctx.emit({ type: "log", message: `${label(item)}: done from this account before, skipped` }); return null; }
    if (budget <= 0) { ctx.emit({ type: "log", message: `${noun} allowance used up; the rest wait for the next run` }); return "stop"; }
    let result;
    try { result = await act(item); } catch (err) {
      if (!(err instanceof InviteLimitReached)) throw err;
      store.actions.record({ accountId, target, action, status: "limit", detail: err.message, runId });
      ctx.emit({ type: "log", message: err.message });
      return "stop";
    }
    store.actions.record({ accountId, target, action, status: result.status, detail: result.detail, runId });
    ctx.emit({ type: "log", message: `${label(item)}: ${result.status}${result.detail ? ` (${result.detail})` : ""}` });
    if (result.status !== "sent") { await ctx.linkedin.pause(); return null; }
    budget--;
    // No wait after the last one; the run can end as soon as the allowance is spent.
    if (budget > 0) await ctx.linkedin.pause(gap || undefined);
    return { ...item, ...result.extra };
  });
}

const ITEM_KINDS = [["person", "People (/in/ links)"], ["page", "Company or school pages"], ["post", "Posts"]];

function describe(item) {
  const fields = item.kind === "post"
    ? { author: item.authorName, authorHeadline: item.authorHeadline, post: item.text }
    : item.kind === "page"
    ? { page: item.name || item.pageUrl }
    : { name: item.name, headline: item.headline, location: item.location, connection: item.degree, about: item.about, experience: item.experience, theirComment: item.comment, onPost: item.source?.postText?.slice(0, 600) };
  return JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, v]) => v)), null, 1);
}

module.exports = { DAY, eachItem, actOnEach, withFirstName, label, postKey, describe, ITEM_KINDS };
