// Every step the editor offers: what it accepts, what it emits, the settings it shows, and what it does. The editor reads this list over IPC, so a new step only needs an entry here.

const { render, renderOutgoing, firstName, matchesAny } = require("./domain/text.cjs");
const { itemFromUrl } = require("./domain/linkedinData.cjs");
const { qualifies } = require("./domain/qualify.cjs");
const { outputInstruction, readAnswer, fieldProblems } = require("./domain/aiOutput.cjs");
const { evaluate, ruleProblems } = require("./domain/condition.cjs");
const { LIMITS } = require("./constants.cjs");
const { DAY, eachItem, actOnEach, withFirstName, postKey, describe, ITEM_KINDS } = require("./steps.cjs");

// The palette shows groups in this order; steps keep their order inside a group.
const GROUPS = ["Triggers", "Search", "Feed", "Posts", "Profile", "Messaging", "CRM", "AI", "Logic"];

// The answer is stored on the item, so it must be a plain field name that does not overwrite what identifies the item.
const IDENTITY_FIELDS = new Set(["kind", "name", "firstName", "profileUrl", "postUrl", "postUrn", "pageUrl", "authorUrl", "authorName"]);
function outputKeyProblems(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return [`Store the answer as "${k}": use letters, digits and _ only`];
  return IDENTITY_FIELDS.has(k) ? [`Store the answer as "${k}" would overwrite the item's own ${k}`] : [];
}

const steps = {
  start: {
    label: "Start", group: "Triggers", icon: "Play", description: "Where a run begins. Press Run to fire it.",
    input: null, outputs: [{ handle: "out", kind: "trigger" }], params: [],
    run: async () => ({ out: [{ kind: "trigger" }] }),
  },

  schedule: {
    label: "Schedule", group: "Triggers", icon: "Clock", description: "Fires on its own while the workflow is Active and the app is open: every so often, inside working hours, on the days you pick.",
    input: null, outputs: [{ handle: "out", kind: "trigger" }],
    params: [
      { key: "everyMinutes", label: "Every (minutes, 15 or more)", kind: "number", default: 240 },
      { key: "fromHour", label: "From hour (0-23)", kind: "number", default: 9 },
      { key: "toHour", label: "Until hour (1-24)", kind: "number", default: 19 },
      { key: "days", label: "Days", kind: "select", default: "weekdays", options: [["weekdays", "Monday to Friday"], ["everyday", "Every day"], ["weekends", "Saturday and Sunday"]] },
      { key: "jitterMinutes", label: "Random shift (± minutes)", kind: "number", default: 20 },
    ],
    run: async () => ({ out: [{ kind: "trigger" }] }),
  },

  pollApi: {
    label: "Poll API", group: "Triggers", icon: "Webhook", description: "Checks a JSON API on a timer while the workflow is Active. Each record it has not seen before becomes an item, from the LinkedIn link in the field you name.",
    input: null, outputs: [{ handle: "out", kind: "param:itemKind" }],
    params: [
      { key: "url", label: "API URL", kind: "text", required: true, default: "" },
      { key: "headers", label: "Headers as JSON (optional), e.g. {\"Authorization\": \"Bearer …\"}", kind: "textarea", default: "" },
      { key: "itemsPath", label: "Path to the list in the answer (blank = the answer is the list)", kind: "text", default: "" },
      { key: "urlField", label: "Field holding the LinkedIn link", kind: "text", required: true, default: "linkedinUrl" },
      { key: "keyField", label: "Field that identifies a record (blank = the link)", kind: "text", default: "" },
      { key: "itemKind", label: "The links are", kind: "select", default: "person", options: ITEM_KINDS },
      { key: "everyMinutes", label: "Check every (minutes, 5 or more)", kind: "number", default: 30 },
      { key: "maxItems", label: "Max new records per run", kind: "number", default: 25 },
    ],
    // A scheduled poll arrives with its records already fetched; pressing Run fetches now. Either way a record is used once.
    run: async (_items, _p, ctx) => {
      if (ctx.trigger?.firedBy === ctx.nodeId) return { out: ctx.trigger.items || [] };
      const { items, rejected, total } = await ctx.pollNow(ctx.nodeId);
      ctx.emit({ type: "log", message: `API returned ${total} records: ${items.length} new${rejected ? `, ${rejected} without a usable link` : ""}` });
      return { out: items };
    },
  },

  searchPosts: {
    label: "Search posts", group: "Search", icon: "Search", description: "Types keywords into LinkedIn's post search and collects the posts it finds.",
    input: "trigger", outputs: [{ handle: "out", kind: "post" }],
    params: [
      { key: "keywords", label: "Keywords", kind: "text", required: true, default: "hiring" },
      { key: "datePosted", label: "Date posted", kind: "select", default: "past-week", options: [["past-24h", "Past 24 hours"], ["past-week", "Past week"], ["past-month", "Past month"], ["any", "Any time"]] },
      { key: "sortBy", label: "Sort by", kind: "select", default: "date_posted", options: [["date_posted", "Latest"], ["relevance", "Top match"]] },
      { key: "limit", label: "Max posts", kind: "number", default: 20 },
    ],
    run: async (_items, p, ctx) => {
      const posts = await ctx.linkedin.searchPosts({ ...p, keywords: p.keywords.trim() });
      const linked = posts.filter((x) => x.postUrl || x.postUrn).length;
      ctx.emit({ type: "log", message: `Found ${posts.length} posts, ${linked} with a link the comment step can open` });
      return { out: posts };
    },
  },

  searchPeople: {
    label: "Search people", group: "Search", icon: "Users", description: "Runs LinkedIn's people search and collects the profiles it lists.",
    input: "trigger", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "keywords", label: "Keywords", kind: "text", required: true, default: "founder B2B" },
      { key: "network", label: "Connection", kind: "select", default: "S", options: [["S", "2nd degree"], ["F", "1st degree"], ["O", "3rd degree and beyond"], ["any", "Anyone"]] },
      { key: "mustMention", label: "Headline or search snippet must mention (comma-separated, blank = anyone)", kind: "text", default: "" },
      { key: "skipContacted", label: "Skip people the CRM shows as already contacted", kind: "select", default: "yes", options: [["yes", "Yes"], ["no", "No"]] },
      { key: "limit", label: "Max people to keep", kind: "number", default: 20 },
      { key: "maxPages", label: "Max result pages to read", kind: "number", default: 10 },
    ],
    run: async (_items, p, ctx) => {
      let mentionSkipped = 0, contactedSkipped = 0;
      // Decided from the result card alone, so nobody's profile is opened just to be rejected.
      const accept = (person) => {
        if (String(p.mustMention || "").trim() && !matchesAny([person.headline, person.snippet].filter(Boolean).join(" \n "), p.mustMention)) { mentionSkipped++; return false; }
        if (p.skipContacted !== "no") {
          const known = ctx.store.crm?.contacts.find(ctx.accountId, person.profileUrl);
          if ((known && known.stage !== "new") || ctx.store.actions.alreadyDone(ctx.accountId, person.profileUrl, "connect")) { contactedSkipped++; return false; }
        }
        return true;
      };
      const people = (await ctx.linkedin.searchPeople({ keywords: p.keywords.trim(), network: p.network, limit: p.limit, maxPages: Number(p.maxPages) || 10, accept })).map(withFirstName);
      ctx.emit({ type: "log", message: `Kept ${people.length} people; skipped ${mentionSkipped} without the words you asked for and ${contactedSkipped} already contacted` });
      return { out: people };
    },
  },

  urlList: {
    label: "LinkedIn URLs", group: "Search", icon: "Link", description: "A fixed list of profile, page or post links you paste in, one per line.",
    input: "trigger", outputs: [{ handle: "out", kind: "param:itemKind" }],
    params: [
      { key: "urls", label: "Links, one per line", kind: "textarea", required: true, default: "" },
      { key: "itemKind", label: "The links are", kind: "select", default: "page", options: ITEM_KINDS },
    ],
    run: async (_items, p, ctx) => {
      const lines = String(p.urls).split(/\s+/).map((l) => l.trim()).filter(Boolean);
      const items = [];
      for (const line of lines) {
        const item = itemFromUrl(line);
        if (item?.kind === p.itemKind && !items.some((i) => (i.profileUrl || i.pageUrl || i.postUrl) === (item.profileUrl || item.pageUrl || item.postUrl))) items.push(item);
        else if (item?.kind !== p.itemKind) ctx.emit({ type: "item.failed", message: `${line}: not a ${p.itemKind} link, skipped` });
      }
      return { out: items };
    },
  },

  feedPosts: {
    label: "Feed posts", group: "Feed", icon: "Newspaper", description: "Scrolls this account's LinkedIn home feed and collects the posts on it, skipping ads.",
    input: "trigger", outputs: [{ handle: "out", kind: "post" }],
    params: [{ key: "limit", label: "Max posts", kind: "number", default: 20 }],
    run: async (_items, p, ctx) => {
      const posts = await ctx.linkedin.readFeed({ limit: p.limit });
      ctx.emit({ type: "log", message: `Read ${posts.length} posts from the feed, ${posts.filter((x) => x.postUrl || x.postUrn).length} with a link later steps can open` });
      return { out: posts };
    },
  },

  postCommenters: {
    label: "Post commenters", group: "Posts", icon: "MessageSquare", description: "Opens each post, loads its comments, and keeps the people whose comment contains one of your words.",
    input: "post", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "matchWords", label: "Comment contains (comma-separated, blank = everyone)", kind: "text", default: "interested" },
      { key: "limitPerPost", label: "Max comments read per post", kind: "number", default: 50 },
    ],
    run: async (posts, p, ctx) => {
      const seen = new Set();
      const people = [];
      await eachItem(posts, ctx, async (post) => {
        const { people: commenters, note } = await ctx.linkedin.commentersOf(post, { limit: p.limitPerPost });
        if (note) ctx.emit({ type: "log", message: `${post.authorName}'s post: ${note}` });
        const kept = commenters.filter((c) => matchesAny(c.comment, p.matchWords) && !seen.has(c.profileUrl));
        kept.forEach((c) => { seen.add(c.profileUrl); people.push(withFirstName(c)); });
        ctx.emit({ type: "log", message: `${post.authorName}'s post: ${commenters.length} commenters, ${kept.length} matched` });
        await ctx.linkedin.pause();
      });
      return { out: people };
    },
  },

  like: {
    label: "Like post", group: "Posts", icon: "ThumbsUp", description: "Reacts to each post. Skips posts this account already reacted to. Emits the posts it reacted to.",
    input: "post", outputs: [{ handle: "out", kind: "post" }],
    params: [
      { key: "reaction", label: "Reaction", kind: "select", default: "like", options: [["like", "Like"], ["celebrate", "Celebrate"], ["support", "Support"], ["love", "Love"], ["insightful", "Insightful"], ["funny", "Funny"]] },
      { key: "perDay", label: "Max reactions per 24 hours", kind: "number", default: LIMITS.LIKE_PER_DAY },
    ],
    run: async (posts, p, ctx) => ({
      out: await actOnEach(posts, ctx, { action: "like", noun: "Reaction", perDay: p.perDay, targetOf: postKey, act: (post) => ctx.linkedin.like(post, p.reaction) }),
    }),
  },

  comment: {
    label: "Comment on post", group: "Posts", icon: "MessageCircle", description: "Posts a comment under each post, once per post per account. Pair it with AI write message and use {{draft}}.",
    input: "post", outputs: [{ handle: "out", kind: "post" }],
    params: [
      { key: "text", label: "Comment ({{draft}}, {{authorName}} and other fields work)", kind: "textarea", required: true, default: "{{draft}}" },
      { key: "perDay", label: "Max comments per 24 hours", kind: "number", default: LIMITS.COMMENT_PER_DAY },
    ],
    run: async (posts, p, ctx) => ({
      out: await actOnEach(posts, ctx, {
        action: "comment", noun: "Comment", perDay: p.perDay, targetOf: postKey,
        act: async (post) => {
          const text = renderOutgoing(p.text, { ...post, authorFirstName: firstName(post.authorName) });
          if (!text) throw new Error("the comment came out empty");
          return { ...(await ctx.linkedin.comment(post, text)), extra: { commented: text } };
        },
      }),
    }),
  },

  repost: {
    label: "Repost", group: "Posts", icon: "Repeat2", description: "Reposts each post to your feed, with your own words on top if you write them. Once per post per account.",
    input: "post", outputs: [{ handle: "out", kind: "post" }],
    params: [
      { key: "thoughts", label: "Your thoughts (blank = plain repost; {{draft}} works)", kind: "textarea", default: "" },
      { key: "perDay", label: "Max reposts per 24 hours", kind: "number", default: LIMITS.REPOST_PER_DAY },
    ],
    run: async (posts, p, ctx) => ({
      out: await actOnEach(posts, ctx, {
        action: "repost", noun: "Repost", perDay: p.perDay, targetOf: postKey,
        act: async (post) => {
          const thoughts = renderOutgoing(p.thoughts, post);
          return { ...(await ctx.linkedin.repost(post, thoughts)), extra: { reposted: thoughts || true } };
        },
      }),
    }),
  },

  visitProfile: {
    label: "Visit profile", group: "Profile", icon: "UserSearch", description: "Opens each profile and reads headline, location, connection degree, About and Experience.",
    input: "person", outputs: [{ handle: "out", kind: "person" }], params: [],
    run: async (people, _p, ctx) => ({
      out: await eachItem(people, ctx, async (person) => {
        const profile = await ctx.linkedin.readProfile(person.profileUrl);
        await ctx.linkedin.pause();
        return withFirstName({ ...person, ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v != null)), name: profile.name || person.name });
      }),
    }),
  },

  follow: {
    label: "Follow", group: "Profile", icon: "BellPlus", description: "Follows company or school pages, people, or the authors of posts. Emits what it followed.",
    input: ["page", "person", "post"], outputs: [{ handle: "out", kind: "same" }],
    params: [{ key: "perDay", label: "Max follows per 24 hours", kind: "number", default: LIMITS.FOLLOW_PER_DAY }],
    run: async (items, p, ctx) => ({
      out: await actOnEach(items, ctx, {
        action: "follow", noun: "Follow", perDay: p.perDay, targetOf: (x) => x.pageUrl || x.profileUrl || x.authorUrl,
        act: (item) => ctx.linkedin.follow(item),
      }),
    }),
  },

  connect: {
    label: "Send connection request", group: "Profile", icon: "UserPlus", description: "Sends an invite, with a note if you write one. Skips anyone already invited or connected from this account. Emits the people it invited.",
    input: "person", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "note", label: "Note (blank = no note; {{firstName}}, {{draft}} and other fields work)", kind: "textarea", default: "" },
      { key: "noteMode", label: "Add the note", kind: "select", default: "available", options: [["available", "When the account can (otherwise send without)"], ["always", "Always (skip the person if it cannot)"], ["never", "Never"]] },
      { key: "perRun", label: "Max invites per run (blank = no run limit)", kind: "number", default: "" },
      { key: "perRunJitter", label: "Vary the per-run limit by ±", kind: "number", default: 0 },
      { key: "perDay", label: "Max invites per 24 hours", kind: "number", default: LIMITS.CONNECT_PER_DAY },
      { key: "perWeek", label: "Max invites per 7 days", kind: "number", default: LIMITS.CONNECT_PER_WEEK },
      { key: "minGapSeconds", label: "Wait between invites, at least (seconds)", kind: "number", default: 3 },
      { key: "maxGapSeconds", label: "Wait between invites, at most (seconds)", kind: "number", default: 6 },
    ],
    run: async (people, p, ctx) => {
      const settingKey = `notes.unavailableUntil.${ctx.accountId}`;
      const notesBlocked = () => (ctx.store.settings.get(settingKey) || 0) > Date.now();
      if (p.noteMode === "available" && String(p.note || "").trim() && notesBlocked()) ctx.emit({ type: "log", message: "This account ran out of personalised notes recently, so invites go without a note" });
      return {
        out: await actOnEach(people, ctx, {
          action: "connect", noun: "Invite", perDay: p.perDay, perWeek: p.perWeek, perRun: p.perRun, perRunJitter: p.perRunJitter, gapSeconds: [p.minGapSeconds, p.maxGapSeconds], targetOf: (x) => x.profileUrl,
          act: async (person) => {
            const wantNote = p.noteMode !== "never" && String(p.note || "").trim() && !(p.noteMode === "available" && notesBlocked());
            const note = wantNote ? renderOutgoing(p.note, withFirstName(person)) : "";
            if (note.length > LIMITS.NOTE_MAX_CHARS) throw new Error(`note is ${note.length} characters; LinkedIn allows ${LIMITS.NOTE_MAX_CHARS}`);
            const result = await ctx.linkedin.connect(person, note, { fallbackWithoutNote: p.noteMode === "available" });
            if (result.noteUnavailable) {
              // Free accounts get their personalised notes back monthly; a week is a cheap re-check that does not fail every invite until then.
              ctx.store.settings.set(settingKey, Date.now() + LIMITS.NOTE_RECHECK_DAYS * DAY);
              ctx.emit({ type: "log", message: `This account cannot add a note right now; ${p.noteMode === "available" ? "sending invites without one" : "skipping people until notes are available"}` });
            }
            return { ...result, extra: { invitedWith: result.noteUsed ? note : null } };
          },
        }),
      };
    },
  },

  message: {
    label: "Send message", group: "Messaging", icon: "Send", description: "Messages 1st-degree connections. Never writes into a conversation that already has messages. Emits the people it messaged.",
    input: "person", outputs: [{ handle: "out", kind: "person" }],
    params: [
      { key: "text", label: "Message ({{firstName}}, {{draft}} and other fields work)", kind: "textarea", required: true, default: "Hi {{firstName}}, {{draft}}" },
      { key: "perDay", label: "Max messages per 24 hours", kind: "number", default: LIMITS.MESSAGE_PER_DAY },
    ],
    run: async (people, p, ctx) => ({
      out: await actOnEach(people, ctx, {
        action: "message", noun: "Message", perDay: p.perDay, targetOf: (x) => x.profileUrl,
        act: async (person) => {
          const text = renderOutgoing(p.text, withFirstName(person));
          if (!text) throw new Error("the message came out empty");
          return { ...(await ctx.linkedin.sendMessage(person, text)), extra: { messaged: text } };
        },
      }),
    }),
  },

  aiPrompt: {
    label: "AI prompt", group: "AI", icon: "Sparkles", description: "Asks the model your own question about each item and stores the answer in the fields you define, for later steps and conditions to use.",
    input: "any", outputs: [{ handle: "out", kind: "same" }],
    params: [
      { key: "prompt", label: "Prompt ({{firstName}}, {{headline}} and other fields work; the full item is sent too)", kind: "textarea", required: true, default: "Is {{firstName}} likely to buy B2B sales software? Score the fit and give the reason." },
      { key: "outputFields", label: "Answer fields", kind: "outputFields", required: true, default: [{ name: "score", type: "number", description: "0-100 fit" }, { name: "reason", type: "text", description: "one sentence" }] },
      { key: "outputKey", label: "Store the answer as (later steps use {{ai.score}})", kind: "text", default: "ai", help: "Letters, digits and _ only." },
    ],
    validate: (p) => [...fieldProblems(p.outputFields), ...outputKeyProblems(p.outputKey)],
    run: async (items, p, ctx) => {
      const key = String(p.outputKey || "").trim() || "ai";
      const out = await eachItem(items, ctx, async (item) => {
        const res = await ctx.llm.chatJson({
          system: "You answer questions about LinkedIn people and posts. Reply with only a JSON object, no prose.",
          user: `${render(p.prompt, { ...withFirstName(item), authorFirstName: firstName(item.authorName) })}\n\nItem:\n${describe(item)}\n\n${outputInstruction(p.outputFields)}`,
        });
        if (!res.ok) throw new Error(res.error);
        const answer = readAnswer(res.value, p.outputFields);
        if (!answer.ok) throw new Error(`unreadable AI answer: ${answer.error}`);
        return { ...item, [key]: answer.value };
      });
      ctx.emit({ type: "log", message: `${out.length} of ${items.length} items answered` });
      return { out };
    },
  },

  qualify: {
    label: "AI qualify", group: "AI", icon: "BadgeCheck", description: "Asks the model whether each item meets your criteria. Passes go out the top, the rest out the bottom.",
    input: "any", outputs: [{ handle: "pass", kind: "same" }, { handle: "fail", kind: "same" }],
    params: [
      { key: "prompt", label: "Who qualifies?", kind: "textarea", required: true, default: "Qualifies if this person runs or leads a B2B business and would plausibly take a sales call." },
      { key: "minScore", label: "Minimum score (0-100)", kind: "number", default: 70 },
    ],
    run: async (items, p, ctx) => {
      const pass = [], fail = [];
      let unreadable = 0;
      await eachItem(items, ctx, async (item) => {
        const res = await ctx.llm.chatJson({
          system: 'You screen LinkedIn leads against criteria. Reply with only a JSON object: {"qualified": true or false, "score": 0-100, "reason": "one short sentence"}. Judge only from the data given; if it is too thin to tell, answer false with a low score.',
          user: `Criteria:\n${p.prompt}\n\nLead:\n${describe(item)}`,
        });
        const verdict = res.ok ? qualifies(res.value, p.minScore) : null;
        if (verdict === null) {
          unreadable++;
          throw new Error(res.error || `unreadable AI answer: ${JSON.stringify(res.value).slice(0, 120)}`);
        }
        const scored = { ...item, evaluation: { qualified: verdict, score: Number(res.value.score), reason: res.value.reason || "" } };
        (verdict ? pass : fail).push(scored);
      });
      ctx.emit({ type: "log", message: `${pass.length} qualified, ${fail.length} did not, ${unreadable} could not be judged` });
      return { pass, fail };
    },
  },

  compose: {
    label: "AI write message", group: "AI", icon: "PenLine", description: "Writes a note for each person, or a comment for each post. Later steps use it as {{draft}}.",
    input: ["person", "post"], outputs: [{ handle: "out", kind: "same" }],
    params: [
      { key: "instructions", label: "What should the message say?", kind: "textarea", required: true, default: "Write a warm two-sentence note. Mention what they said in their comment, and offer to share details. No emojis, no hashtags." },
      { key: "maxChars", label: "Max characters", kind: "number", default: LIMITS.NOTE_MAX_CHARS },
    ],
    run: async (people, p, ctx) => ({
      out: await eachItem(people, ctx, async (person) => {
        const max = Number(p.maxChars) || LIMITS.NOTE_MAX_CHARS;
        const res = await ctx.llm.chatJson({
          system: `You write short LinkedIn messages and comments that sound like a person typed them. Reply with only a JSON object: {"message": "..."}. Hard limit ${max} characters. Plain text, no placeholders, no sign-off line.`,
          user: `Instructions:\n${p.instructions}\n\n${person.kind === "post" ? "The post you are replying to" : "Recipient"}:\n${describe(person)}`,
        });
        if (!res.ok) throw new Error(res.error);
        const draft = String(res.value.message || "").trim();
        if (!draft) throw new Error("the AI returned an empty message");
        if (draft.length > max) throw new Error(`the AI wrote ${draft.length} characters, over the ${max} limit`);
        return { ...person, draft };
      }),
    }),
  },

  condition: {
    label: "Condition", group: "Logic", icon: "GitBranch", description: "Sends each item out True or False by your rules on its fields, such as an AI prompt's score. No AI, no cost.",
    input: "any", outputs: [{ handle: "true", kind: "same" }, { handle: "false", kind: "same" }],
    params: [{ key: "rules", label: "Rules", kind: "conditions", required: true, default: { match: "all", rules: [{ field: "ai.score", op: "atLeast", value: 70 }] } }],
    validate: (p) => ruleProblems(p.rules),
    run: async (items, p) => {
      const hit = (i) => evaluate(p.rules, i);
      return { true: items.filter(hit), false: items.filter((i) => !hit(i)) };
    },
  },

  filter: {
    label: "Keyword filter", group: "Logic", icon: "Filter", description: "Splits items by whether a field contains one of your words. No AI, no cost.",
    input: "any", outputs: [{ handle: "pass", kind: "same" }, { handle: "fail", kind: "same" }],
    params: [
      { key: "field", label: "Field", kind: "select", default: "headline", options: [["headline", "Headline"], ["comment", "Their comment"], ["about", "About"], ["experience", "Experience"], ["location", "Location"], ["text", "Post text"], ["degree", "Connection degree (1st, 2nd, 3rd)"]] },
      { key: "words", label: "Contains any of (comma-separated)", kind: "text", required: true },
    ],
    run: async (items, p) => {
      const hit = (i) => matchesAny(i[p.field], p.words);
      return { pass: items.filter(hit), fail: items.filter((i) => !hit(i)) };
    },
  },
};

// CRM and follow-up steps live in their own file; they share the helpers in steps.cjs. Sorting by group puts them in their place in the palette.
const byGroup = Object.entries({ ...steps, ...require("./nodes.crm.cjs").catalog }).sort(([, a], [, b]) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
const catalog = Object.fromEntries(byGroup);

for (const [type, def] of Object.entries(catalog)) def.type = type;

// What the renderer needs to draw the palette and settings forms; run and validate stay in the main process, and IPC cannot carry functions anyway.
const describeCatalog = () => Object.values(catalog).map(({ run, validate, ...rest }) => rest);

module.exports = { catalog, describeCatalog, GROUPS };
