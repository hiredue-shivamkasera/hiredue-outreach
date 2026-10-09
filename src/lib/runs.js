// Reading runs, events and the step catalog the same way on every screen: run durations, per-step status folded from events, and the group order of the palette.

export const FIRED_BY = { manual: "Run button", schedule: "Schedule", pollApi: "API poll", followUp: "Follow-up" };
export const RUN_STATUSES = ["running", "finished", "failed", "stopped", "interrupted"];
// The contract's palette order; "Trigger" and "LinkedIn" are the names the catalog used before the regrouping and still sort sensibly.
export const GROUP_ORDER = ["Triggers", "Trigger", "Search", "Feed", "Posts", "Profile", "Messaging", "LinkedIn", "CRM", "AI", "Logic"];
export const TRIGGER_GROUPS = new Set(["Triggers", "Trigger"]);

const ACTION_NOUN = { connect: ["invite", "invites"], message: ["message", "messages"], followup: ["follow-up", "follow-ups"], follow: ["follow", "follows"], like: ["reaction", "reactions"], comment: ["comment", "comments"], repost: ["repost", "reposts"] };
export const actionNoun = (action, n) => (ACTION_NOUN[action] ? ACTION_NOUN[action][n === 1 ? 0 : 1] : action);

export function duration(run) {
  const ms = (run.finishedAt || Date.now()) - run.startedAt;
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const when = (ms) => (ms ? new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
export const clock = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

export function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return when(ms);
}

// Handle ids are camelCase in the catalog; these read as words on a node or in a count.
const BRANCH_NAME = { needsYou: "needs you", noReply: "no reply" };
export const branchName = (h) => BRANCH_NAME[h] || h;
// Branches read in the order a person thinks about them: the good path first, then what needs attention, then what is pending, then what ended.
const BRANCH_RANK = { out: 0, pass: 1, true: 1, replied: 1, sent: 1, needsYou: 2, waiting: 3, fail: 4, false: 4, noReply: 4, closed: 4 };
export const sortHandles = (list, key = (x) => x) => [...list].sort((a, b) => (BRANCH_RANK[key(a)] ?? 9) - (BRANCH_RANK[key(b)] ?? 9));

// How far off a planned time is, for "next: in 3h"; a time already passed reads as due now because the scheduler has not reached it yet.
export function until(ms) {
  if (!ms) return "";
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return "due now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function countsText(c) {
  if (!c) return "";
  return sortHandles(Object.entries(c), ([h]) => h).map(([h, n]) => (h === "out" ? `${n}` : `${n} ${branchName(h)}`)).join(" / ");
}

// Folds run events into what each step shows: running, counts out, failures.
export function stepStatus(events) {
  const status = {};
  for (const e of events) {
    if (!e.nodeId) continue;
    const s = (status[e.nodeId] ||= { failedItems: 0 });
    if (e.type === "node.started") Object.assign(s, { state: "running", input: e.inputCount });
    if (e.type === "node.finished") Object.assign(s, { state: "done", counts: e.counts });
    if (e.type === "node.failed") Object.assign(s, { state: "failed", error: e.message });
    if (e.type === "node.skipped") Object.assign(s, { state: "skipped" });
    if (e.type === "item.failed") s.failedItems++;
  }
  return status;
}

export const isLogEvent = (e) => e.type === "log" || e.type === "item.failed" || e.type === "node.failed";
export const shortLabel = (label) => label.replace(/\s*\(.*\)$/, "");
export const paramText = (p, value) => String((p.kind === "select" ? p.options?.find(([v]) => v === value)?.[1] : typeof value === "object" && value !== null ? JSON.stringify(value) : value) ?? "");

// Branch names sit on the output handles, so edges carry no label of their own.
export const toFlowEdges = (edges) => (edges || []).map((e) => ({ ...e }));
export const groupsOf = (catalog) => [...new Set(catalog.map((d) => d.group))].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
export const itemTitle = (it) => it.name || it.authorName || it.pageUrl || it.profileUrl || "item";
export const itemLink = (it) => it.profileUrl || it.postUrl || it.pageUrl || null;
export const actionLink = (target) => (target?.startsWith("urn:") ? `https://www.linkedin.com/feed/update/${target}/` : target);
