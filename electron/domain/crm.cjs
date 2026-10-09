// The CRM's rules: the stage order, how a person's stage moves on its own, and how a run's items become one record per person or post. Pure; the store applies them.

const STAGES = [
  { id: "new", label: "New" },
  { id: "invited", label: "Invited" },
  { id: "connected", label: "Connected" },
  { id: "messaged", label: "Messaged" },
  { id: "replied", label: "Replied" },
  { id: "calendar_sent", label: "Calendar sent" },
  { id: "qualified", label: "Qualified" },
  { id: "meeting", label: "Meeting booked" },
  { id: "won", label: "Won" },
  { id: "dropped", label: "Dropped" },
  { id: "lost", label: "Lost" },
];
const RANK = new Map(STAGES.map((s, i) => [s.id, i]));
// Stages only a person or the Outreach sequence step sets, after reading the conversation; nothing in the ledger is evidence for them. They rank above every automatic stage, so forward-only also means a run never moves someone out of one.
const MANUAL = new Set(["calendar_sent", "qualified", "meeting", "won", "dropped", "lost"]);
const isStage = (s) => RANK.has(s);

function advanceStage(current, signal) {
  const cur = isStage(current) ? current : "new";
  if (!isStage(signal) || MANUAL.has(signal)) return cur;
  return RANK.get(signal) > RANK.get(cur) ? signal : cur;
}

// Ledger statuses that prove the thing happened on LinkedIn; unverified and failed attempts prove nothing.
const IMPLIES = {
  connect: { sent: "invited", pending: "invited", connected: "connected" },
  message: { sent: "messaged", already_messaged: "messaged" },
  followup: { sent: "messaged" },
};

function stageFromSignals({ actions = [], degree = null, replied = false }) {
  let stage = "new";
  for (const a of actions) stage = advanceStage(stage, IMPLIES[a.action]?.[a.status]);
  if (/^1st/i.test(String(degree || ""))) stage = advanceStage(stage, "connected");
  if (replied) stage = advanceStage(stage, "replied");
  return stage;
}

const present = (v) => v !== undefined && v !== null && v !== "";

// Fields a later step left blank keep what an earlier one found; the AI's score from last week still matters when today's run only re-searched.
function mergeSnapshot(existing, item) {
  const pick = (k) => (present(item[k]) ? item[k] : existing?.[k] ?? null);
  const data = { ...(existing?.data || {}), ...Object.fromEntries(Object.entries(item).filter(([, v]) => present(v))) };
  return { name: pick("name"), headline: pick("headline"), location: pick("location"), degree: pick("degree"), data };
}

const postKeyOf = (item) => item.postUrn || item.postUrl || null;

// Outputs are keyed by step in execution order, so merging in that order leaves the furthest step's view on top.
function peopleAndPostsIn(outputs) {
  const people = new Map();
  const posts = new Map();
  for (const byHandle of Object.values(outputs || {})) {
    for (const items of Object.values(byHandle || {})) {
      for (const item of items || []) {
        if (item?.kind === "person" && item.profileUrl) people.set(item.profileUrl, { ...(people.get(item.profileUrl) || {}), ...Object.fromEntries(Object.entries(item).filter(([, v]) => present(v))) });
        else if (item?.kind === "post" && postKeyOf(item)) { const key = postKeyOf(item); posts.set(key, { ...(posts.get(key) || {}), ...item, postKey: key }); }
      }
    }
  }
  return { people: [...people.values()], posts: [...posts.values()] };
}

const ENGAGEMENT_ACTIONS = ["like", "comment", "repost"];

function engagementOf(actions) {
  const out = {};
  for (const a of [...actions].sort((x, y) => x.at - y.at)) if (ENGAGEMENT_ACTIONS.includes(a.action)) out[a.action] = a.status;
  return out;
}

function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

module.exports = { STAGES, MANUAL, isStage, advanceStage, stageFromSignals, mergeSnapshot, peopleAndPostsIn, postKeyOf, engagementOf, ENGAGEMENT_ACTIONS, parseTags };
