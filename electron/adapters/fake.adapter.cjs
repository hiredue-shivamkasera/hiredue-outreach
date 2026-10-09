// A scripted LinkedIn and language model for the end-to-end tests: the same surface as linkedin.adapter and llm.adapter, instant and deterministic, writing every outward action to OUTREACH_FAKE_LOG so a test can check what was "done on LinkedIn". It never opens a browser or touches the network.

const fs = require("fs");
const path = require("path");
const { NotLoggedIn, InviteLimitReached } = require("./linkedin.adapter.cjs");

const SCENARIOS = ["default", "logged-out", "invite-limit", "flaky", "unverified", "slow", "no-note"];
// LinkedIn's real weekly limit is around 100; two is enough to show the Connect step stopping mid-list.
const INVITE_LIMIT_AFTER = 2;
// Long enough for a test to press Stop while a step is still working through its list.
const SLOW_PAUSE_MS = 250;

const profileUrl = (slug) => `https://www.linkedin.com/in/${slug}/`;
const postUrn = (n) => `urn:li:activity:700000000000000000${n}`;

const PEOPLE = [
  { slug: "ana-seeker", name: "Ana Seeker", headline: "Frontend engineer, open to work", location: "Bangalore, India", degree: "2nd", about: "Looking for my next software role after five years of React.", experience: "Frontend engineer at Shopwise, 2020-2025" },
  { slug: "ben-builder", name: "Ben Builder", headline: "Founder at Ledgerly, B2B SaaS for finance teams", location: "Pune, India", degree: "2nd", about: "I run a 20-person B2B company and take partnership calls myself.", experience: "Founder, Ledgerly, 2021-present" },
  { slug: "cara-student", name: "Cara Student", headline: "Student at State University", location: "Delhi, India", degree: "2nd", about: "Second-year computer science student.", experience: null },
  { slug: "dev-friend", name: "Dev Friend", headline: "Product designer, open to work", location: "Mumbai, India", degree: "1st", about: "Designer looking for a product team to join.", experience: "Product designer at Pixelry, 2019-2025" },
  { slug: "eli-founder", name: "Eli Founder", headline: "Co-founder, B2B logistics platform", location: "Chennai, India", degree: "1st", about: "Founder of a B2B freight startup.", experience: "Co-founder, Shipfast, 2022-present" },
  { slug: "fay-recruiter", name: "Fay Recruiter", headline: "Talent partner at BigCorp", location: "Hyderabad, India", degree: "3rd", about: "I hire engineers for BigCorp.", experience: "Talent partner, BigCorp" },
];

// Returned only for searches that mention Topmate, so the other tests' people searches keep their counts. Slug words drive behaviour: "accepts" accepts a pending invite, "replies" answers our last message, "books" answers a calendar link with a booking.
const MENTORS = [
  { slug: "mia-mentor-accepts-replies-books", name: "Mia Mentor", headline: "Career mentor | 1:1 sessions on topmate.io/mia", location: "Bengaluru, India", degree: "2nd", snippet: null, about: null, experience: null },
  { slug: "raj-coach-accepts", name: "Raj Coach", headline: "SDE II at Amazon", location: "Hyderabad, India", degree: "2nd", snippet: "Current: Mentor at Topmate · helping freshers with placements", about: null, experience: null },
  { slug: "tara-mentor", name: "Tara Mentor", headline: "Placement mentor on Topmate", location: "Pune, India", degree: "3rd", snippet: null, about: null, experience: null },
  { slug: "omar-engineer", name: "Omar Engineer", headline: "Backend engineer at Zeta", location: "Delhi, India", degree: "2nd", snippet: null, about: null, experience: null },
];

const post = (n, author, text, { feed = false, search = true, commenters = [] } = {}) => ({ n, author, text, feed, search, commenters });
const POSTS = [
  post(1, "hana-hiring", "We are hiring frontend engineers in Bangalore. Comment if interested and I will reach out.", { commenters: [["ana-seeker", "Interested! Please share details"], ["cara-student", "Nice post"], ["dev-friend", "keen, dm me"]] }),
  post(2, "ivan-hiring", "Hiring a product designer for our Pune office. Drop a comment below.", { commenters: [["ana-seeker", "interested as well"], ["fay-recruiter", "Great opportunity"]] }),
  post(3, "jo-seller", "Three lessons from closing our first enterprise B2B sales deal: find the champion, price on value, and write the follow-up the same day.", { feed: true }),
  post(4, "kim-meme", "B2B sales memes, tag a friend who needs this", { feed: true }),
  post(5, "lee-feed", "Lessons on hiring your first salesperson: hire for curiosity, not a rolodex.", { feed: true, search: false }),
];
const AUTHORS = { "hana-hiring": "Hana Hiring", "ivan-hiring": "Ivan Hiring", "jo-seller": "Jo Seller", "kim-meme": "Kim Meme", "lee-feed": "Lee Feed" };

// Earlier conversations: Eli already has a thread, so a first message to Eli is refused the way the real adapter refuses it.
const SEEDED_THREADS = { "eli-founder": [{ fromMe: true, text: "Hi Eli, good to connect.", at: 1 }] };
// A page this account already follows, so Follow can be seen returning "already".
const SEEDED_FOLLOWING = ["https://www.linkedin.com/company/already-followed/"];

const titleCase = (slug) => slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const slugOf = (url) => String(url || "").match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase() || null;

// Any /in/ link a test pastes resolves to someone; a slug ending in -1st or -3rd sets the degree, so a test can make people without editing this file.
function personBySlug(slug) {
  const known = PEOPLE.find((p) => p.slug === slug) || MENTORS.find((p) => p.slug === slug);
  if (known) return known;
  const degree = /-1st$/.test(slug) ? "1st" : /-3rd$/.test(slug) ? "3rd" : "2nd";
  return { slug, name: titleCase(slug.replace(/-(1st|2nd|3rd)$/, "")), headline: "Member of LinkedIn", location: "Bengaluru, India", degree, about: null, experience: null };
}

const postItem = (p) => ({ kind: "post", postUrn: postUrn(p.n), postUrl: `https://www.linkedin.com/feed/update/${postUrn(p.n)}/`, activityId: postUrn(p.n).split(":").pop(), authorName: AUTHORS[p.author], authorUrl: profileUrl(p.author), authorHeadline: "Posts on LinkedIn", text: p.text });
const postByItem = (item) => POSTS.find((p) => postUrn(p.n) === item.postUrn || (item.postUrl && item.postUrl.includes(postUrn(p.n))));

function createFakes({ scenario = "default", logFile = process.env.OUTREACH_FAKE_LOG } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown OUTREACH_FAKE scenario "${scenario}"; one of ${SCENARIOS.join(", ")}`);
  const record = (entry) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), scenario, ...entry })}\n`); };
  // LinkedIn's state is per account and outlives the app, so each account's fake world is kept in its profile directory, the way the real session lives in the browser profile; a relaunched test sees the same conversations and invites.
  const worlds = new Map();
  const worldFile = (profileDir) => path.join(profileDir, "fake-linkedin-world.json");
  const worldOf = (profileDir) => {
    if (worlds.has(profileDir)) return worlds.get(profileDir);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(worldFile(profileDir), "utf8")); } catch { /* a new account starts from the seeded world */ }
    const world = saved
      ? { pending: new Set(saved.pending), liked: new Set(saved.liked), following: new Set(saved.following), threads: new Map(saved.threads), invitesSent: saved.invitesSent }
      : { pending: new Set(), liked: new Set(), following: new Set(SEEDED_FOLLOWING), threads: new Map(Object.entries(SEEDED_THREADS).map(([s, m]) => [profileUrl(s), m.map((x) => ({ ...x }))])), invitesSent: 0 };
    worlds.set(profileDir, world);
    return world;
  };
  const persist = (profileDir) => {
    const w = worldOf(profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(worldFile(profileDir), JSON.stringify({ pending: [...w.pending], liked: [...w.liked], following: [...w.following], threads: [...w.threads], invitesSent: w.invitesSent }));
  };
  const openDirs = new Set();

  function createLinkedIn(profileDir, { log = () => {} } = {}) {
    const world = worldOf(profileDir);
    const accountId = path.basename(path.dirname(profileDir));
    const act = (action, target, status, extra = {}) => { record({ accountId, profileDir, action, target, status, ...extra }); persist(profileDir); return status; };
    // In the unverified scenario LinkedIn never shows its proof, so every action that would have gone through comes back unverified.
    const outcome = () => (scenario === "unverified" ? "unverified" : "sent");
    // The flaky scenario fails the same items every time so a test can name them.
    const flaky = (what) => scenario === "flaky" && what;

    async function ensureLoggedIn() {
      if (scenario === "logged-out") throw new NotLoggedIn("This account is not logged in to LinkedIn; log in again from the Accounts screen");
      return profileUrl(`me-${accountId.slice(0, 8)}`);
    }

    async function searchPosts({ keywords, limit = 20 }) {
      const want = String(keywords || "").toLowerCase();
      const found = POSTS.filter((p) => p.search && p.text.toLowerCase().includes(want)).map(postItem);
      log(`Post search: ${found.length} posts on the page`);
      return found.slice(0, Number(limit) || 20);
    }

    async function readFeed({ limit = 20 } = {}) {
      return POSTS.filter((p) => p.feed).map(postItem).slice(0, Number(limit) || 20);
    }

    async function commentersOf(item, { limit = 50 } = {}) {
      const p = postByItem(item);
      if (!p) return { people: [], note: "post has no link to open" };
      const people = p.commenters.map(([slug, text]) => { const who = personBySlug(slug); return { kind: "person", name: who.name, headline: who.headline, profileUrl: profileUrl(slug), comment: text, source: { postUrl: item.postUrl, postText: item.text, postAuthor: item.authorName } }; });
      return { people: people.slice(0, Number(limit) || 50), note: people.length ? null : "no comments found; the comment selectors may be stale" };
    }

    async function searchPeople({ keywords = "", network = "S", limit = 20, accept = () => true }) {
      const degree = { F: "1st", S: "2nd", O: "3rd" }[network];
      const pool = /topmate/i.test(keywords) ? MENTORS : PEOPLE;
      return pool.filter((p) => !degree || p.degree === degree).map((p) => ({ kind: "person", name: p.name, headline: p.headline, location: p.location, degree: degreeOf(p.slug).toLowerCase(), profileUrl: profileUrl(p.slug), snippet: p.snippet || null })).filter((p) => accept(p)).slice(0, Number(limit) || 20);
    }

    // An invite to someone whose slug says "accepts" counts as accepted from the next look on, the way a real person accepts between runs.
    function degreeOf(slug) {
      const p = personBySlug(slug);
      return world.pending.has(profileUrl(slug)) && /(^|-)accepts(-|$)/.test(slug) ? "1st" : p.degree;
    }

    async function readProfile(url) {
      const slug = slugOf(url);
      if (!slug) throw new Error(`not a profile link: ${url}`);
      if (flaky(slug.startsWith("cara"))) throw new Error("the profile page did not load");
      const p = personBySlug(slug);
      const degree = degreeOf(slug);
      return { name: p.name, headline: p.headline, location: p.location, degree, isPending: degree !== "1st" && world.pending.has(profileUrl(slug)), profileUrn: `ACoAA${slug.replace(/-/g, "")}`, about: p.about, experience: p.experience };
    }

    async function connect(person, note, { fallbackWithoutNote = false } = {}) {
      const before = await readProfile(person.profileUrl);
      const target = profileUrl(slugOf(person.profileUrl));
      if (before.isPending) return { status: act("connect", target, "pending"), profile: before };
      if (before.degree === "1st") return { status: act("connect", target, "connected"), profile: before };
      if (scenario === "invite-limit" && world.invitesSent >= INVITE_LIMIT_AFTER) { act("connect", target, "limit"); throw new InviteLimitReached("LinkedIn says this account has reached its weekly invitation limit"); }
      // The no-note scenario is a free account whose personalised notes are used up: Add a note leads to a Premium upsell.
      const noteUnavailable = scenario === "no-note" && !!note;
      if (noteUnavailable && !fallbackWithoutNote) return { status: act("connect", target, "unverified", { note: null }), profile: before, noteUnavailable, detail: "this account cannot add a note right now; nothing was sent" };
      const noteUsed = !!note && !noteUnavailable;
      const status = outcome();
      if (status === "sent") { world.pending.add(target); world.invitesSent++; }
      act("connect", target, status, { note: noteUsed ? note : null });
      return { status, profile: { ...before, isPending: status === "sent" }, noteUsed, noteUnavailable };
    }

    // intoExistingThread is how a follow-up writes into the conversation a first message started; a first message never does.
    async function sendMessage(person, text, { intoExistingThread = false } = {}) {
      const profile = await readProfile(person.profileUrl);
      const target = profileUrl(slugOf(person.profileUrl));
      const action = intoExistingThread ? "followup" : "message";
      if (profile.degree !== "1st") return { status: act(action, target, "not_connected"), profile };
      const thread = world.threads.get(target) || [];
      if (thread.length && !intoExistingThread) return { status: act(action, target, "already_messaged"), profile };
      const status = outcome();
      if (status === "sent") world.threads.set(target, [...thread, { fromMe: true, text, at: Date.now() }]);
      act(action, target, status, { text });
      return { status, profile };
    }

    // A test makes someone "reply" by putting -replies in their slug; everyone else stays silent. Like the real adapter, a conversation that cannot be opened is { messages: null, reason }, never an empty list.
    async function readThread(person) {
      const target = profileUrl(slugOf(person.profileUrl));
      if (degreeOf(slugOf(target)) !== "1st") return { messages: null, reason: "not a 1st-degree connection, so there is no conversation to open" };
      if (!world.threads.has(target)) world.threads.set(target, []);
      const thread = world.threads.get(target);
      const last = thread[thread.length - 1];
      if (/-books(-|$)/.test(slugOf(target)) && last?.fromMe && /https?:\/\//.test(last.text)) thread.push({ fromMe: false, text: "Booked a slot for Thursday, see you then.", at: Date.now() });
      else if (/-replies(-|$)/.test(slugOf(target)) && last?.fromMe) thread.push({ fromMe: false, text: "Thanks, happy to chat next week.", at: Date.now() });
      persist(profileDir);
      record({ accountId, profileDir, action: "thread.read", target, replied: thread.some((m) => !m.fromMe) });
      return { messages: thread.map((m) => ({ ...m })) };
    }

    async function like(item, reaction = "like") {
      const key = item.postUrn || item.postUrl;
      if (flaky(postByItem(item)?.n === 4)) return { status: act("like", key, "failed", { reaction }), detail: "no Like button on the post" };
      if (world.liked.has(key)) return { status: act("like", key, "already", { reaction }) };
      const status = outcome();
      if (status === "sent") world.liked.add(key);
      return { status: act("like", key, status, { reaction }) };
    }

    async function comment(item, text) {
      return { status: act("comment", item.postUrn || item.postUrl, outcome(), { text }) };
    }

    async function repost(item, thoughts) {
      return { status: act("repost", item.postUrn || item.postUrl, outcome(), { thoughts: thoughts || null }) };
    }

    async function follow(item) {
      const url = item.pageUrl || item.profileUrl || item.authorUrl;
      if (!url) throw new Error("nothing to follow: no page or profile link");
      if (world.following.has(url)) return { status: act("follow", url, "already") };
      const status = outcome();
      if (status === "sent") world.following.add(url);
      return { status: act("follow", url, status) };
    }

    const pause = () => new Promise((r) => setTimeout(r, scenario === "slow" ? SLOW_PAUSE_MS : 0));

    return { ensureLoggedIn, searchPosts, readFeed, commentersOf, searchPeople, readProfile, connect, sendMessage, readThread, like, comment, repost, follow, pause };
  }

  const linkedinAccess = {
    isOpen: (profileDir) => openDirs.has(profileDir),
    async open(profileDir, { log } = {}) {
      openDirs.add(profileDir);
      record({ accountId: path.basename(path.dirname(profileDir)), profileDir, action: "session.open" });
      return { linkedin: createLinkedIn(profileDir, { log }), close: async () => { openDirs.delete(profileDir); } };
    },
    async login(profileDir) {
      record({ accountId: path.basename(path.dirname(profileDir)), profileDir, action: "session.login" });
      return { profileUrl: profileUrl(`me-${path.basename(path.dirname(profileDir)).slice(0, 8)}`) };
    },
  };

  return { linkedinAccess, llm: createFakeLlm() };
}

const leadOf = (user) => { const i = user.indexOf("{"); try { return JSON.parse(user.slice(i)); } catch { return {}; } };

// Verdicts follow the starter workflows' criteria so each template has a known outcome; a criteria text with "quoted" words qualifies leads that contain them, which is how ad-hoc test workflows pick their passes.
function qualifyAnswer(user) {
  const criteria = user.slice(0, user.indexOf("\n\nLead:"));
  const lead = user.slice(user.indexOf("\n\nLead:")).toLowerCase();
  if (/unreadable/.test(lead)) return { qualified: "maybe" };
  const quoted = [...criteria.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  let fit;
  if (quoted.length) fit = quoted.some((w) => lead.includes(w));
  else if (/B2B company/i.test(criteria)) fit = /founder/.test(lead);
  else if (/post shares/i.test(criteria)) fit = /lessons/.test(lead);
  else if (/looking for a job/i.test(criteria)) fit = /open to work|looking for/.test(lead);
  else fit = false;
  return { qualified: fit, score: fit ? 85 : 20, reason: fit ? "Matches the criteria." : "Does not match the criteria." };
}

function composeAnswer(user) {
  const lead = leadOf(user);
  if (lead.post) return { message: `Useful point about ${lead.post.split(/\s+/).slice(0, 3).join(" ")}.` };
  return { message: `Good to meet you, ${String(lead.name || "there").split(" ")[0]}. Saw your note and would like to connect.` };
}

// Reads the field list from the instruction aiOutput.cjs appends, and answers every field from one fit verdict: founders and heads of sales fit, or whoever contains a word the prompt "quotes". An item mentioning "unreadable" gets an answer missing its first field.
function aiPromptAnswer(user) {
  const [prompt, rest = ""] = user.split("\n\nItem:\n");
  const item = rest.slice(0, rest.indexOf("\n\nReply with only")).toLowerCase();
  const quoted = [...prompt.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const fit = quoted.length ? quoted.some((w) => item.includes(w)) : /founder|head of sales/.test(item);
  const fields = [...rest.matchAll(/^- "(\w+)": (.+)$/gm)].map(([, name, type]) => ({ name, type }));
  const value = {};
  for (const { name, type } of fields) {
    if (type.startsWith("a number")) value[name] = fit ? 85 : 20;
    else if (type.startsWith("true or false")) value[name] = fit;
    else if (type.startsWith("one of ")) { const choices = [...type.matchAll(/"([^"]+)"/g)].map((m) => m[1]); value[name] = fit ? choices[0] : choices[choices.length - 1]; }
    else value[name] = fit ? "Matches what the prompt asks for." : "Does not match what the prompt asks for.";
  }
  if (/unreadable/.test(item) && fields.length) delete value[fields[0].name];
  return value;
}

// Classifies the reply text the Outreach sequence sends, by the same words a person would go by.
function replyAnswer(user) {
  const reply = user.slice(user.indexOf("Their reply:\n") + 13, user.indexOf("\n\nReply with only")).toLowerCase();
  if (/booked|scheduled/.test(reply)) return { class: "booked", reason: "They say a slot is booked." };
  if (/not interested|no thanks|stop/.test(reply)) return { class: "not_interested", reason: "They decline." };
  if (/happy to chat|sure|yes|interested/.test(reply)) return { class: "interested", reason: "They are open to a chat." };
  return { class: "other", reason: "Needs a person to answer." };
}

function createFakeLlm() {
  return {
    async chatJson({ system, user }) {
      if (/screen LinkedIn leads/i.test(system)) return { ok: true, value: qualifyAnswer(user) };
      if (/write short LinkedIn messages/i.test(system)) return { ok: true, value: composeAnswer(user) };
      if (/read replies to LinkedIn outreach/i.test(system)) return { ok: true, value: replyAnswer(user) };
      if (/Reply with only a JSON object with exactly these keys/.test(user)) return { ok: true, value: aiPromptAnswer(user) };
      return { ok: false, error: `the fake model does not know this prompt: ${system.slice(0, 80)}` };
    },
  };
}

module.exports = { createFakes, SCENARIOS, INVITE_LIMIT_AFTER };
