// The built-in workflows, each added once to every install (see seedBuiltIns in main.cjs). They are ordinary workflows afterwards: edit or delete them like any other. A key never changes once shipped; it is how an install knows it already has one.

// Four steps to a row keeps the canvas readable at fit-to-view; the second row continues left to right.
const at = (i) => ({ x: 40 + (i % 4) * 300, y: 80 + Math.floor(i / 4) * 200 });
const edge = (source, target, sourceHandle = "out") => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });

const hiringCommenters = {
  key: "hiring-commenters",
  name: "Hiring post commenters",
  nodes: [
    { id: "start", type: "start", position: at(0), params: {} },
    { id: "posts", type: "searchPosts", position: at(1), params: { keywords: "hiring", datePosted: "past-week", sortBy: "date_posted", limit: 10 } },
    { id: "commenters", type: "postCommenters", position: at(2), params: { matchWords: "interested, keen, dm me, please share", limitPerPost: 50 } },
    { id: "profile", type: "visitProfile", position: at(3), params: {} },
    { id: "qualify", type: "qualify", position: at(4), params: { prompt: "Qualifies if this person is actively looking for a job (their comment, headline or About says so) and has worked in a software, product, data or design role.", minScore: 70 } },
    { id: "write", type: "compose", position: at(5), params: { instructions: "Write a friendly two-sentence connection note. Mention the post they commented on and that you help job seekers get more interviews. No emojis, no hashtags.", maxChars: 280 } },
    { id: "connect", type: "connect", position: at(6), params: { note: "{{draft}}", perDay: 20, perWeek: 100 } },
  ],
  edges: [edge("start", "posts"), edge("posts", "commenters"), edge("commenters", "profile"), edge("profile", "qualify"), edge("qualify", "write", "pass"), edge("write", "connect")],
};

const b2bQualifiers = {
  key: "b2b-qualifiers",
  name: "B2B call qualifiers",
  nodes: [
    { id: "start", type: "start", position: at(0), params: {} },
    { id: "people", type: "searchPeople", position: at(1), params: { keywords: "founder B2B SaaS", network: "S", limit: 20 } },
    { id: "profile", type: "visitProfile", position: at(2), params: {} },
    { id: "qualify", type: "qualify", position: at(3), params: { prompt: "Qualifies if this person founded or runs a B2B company (not a student, not a job seeker, not at a company over 1000 people) and their role makes them the one who takes vendor or partnership calls.", minScore: 70 } },
    { id: "write", type: "compose", position: at(4), params: { instructions: "Write a two-sentence connection note that refers to something specific in their experience and asks if they are open to a short call. No emojis.", maxChars: 280 } },
    { id: "connect", type: "connect", position: at(5), params: { note: "{{draft}}", perDay: 20, perWeek: 100 } },
  ],
  edges: [edge("start", "people"), edge("people", "profile"), edge("profile", "qualify"), edge("qualify", "write", "pass"), edge("write", "connect")],
};

// Inactive when created: it fires on its own only after someone reviews it and switches it on.
const postEngagement = {
  key: "daily-engagement",
  name: "Daily post engagement",
  nodes: [
    { id: "schedule", type: "schedule", position: at(0), params: { everyMinutes: 240, fromHour: 10, toHour: 18, days: "weekdays", jitterMinutes: 25 } },
    { id: "posts", type: "searchPosts", position: at(1), params: { keywords: "B2B sales", datePosted: "past-24h", sortBy: "date_posted", limit: 5 } },
    { id: "qualify", type: "qualify", position: at(2), params: { prompt: "Qualifies if the post shares a real opinion or experience about B2B sales, hiring or growing a company. Not a job ad, not a meme, not self-promotion.", minScore: 70 } },
    { id: "like", type: "like", position: at(3), params: { reaction: "insightful", perDay: 20 } },
    { id: "write", type: "compose", position: at(4), params: { instructions: "Write a one or two sentence comment that adds a specific point to the post, the way a peer would. No praise openers like 'Great post', no emojis, no hashtags.", maxChars: 250 } },
    { id: "comment", type: "comment", position: at(5), params: { text: "{{draft}}", perDay: 5 } },
  ],
  edges: [edge("schedule", "posts"), edge("posts", "qualify"), edge("qualify", "like", "pass"), edge("like", "write"), edge("write", "comment")],
};

// Shows the owner-defined AI answer feeding a Condition: the model only scores, the rules decide who gets an invite.
const aiFitCheck = {
  key: "ai-fit-check",
  name: "AI fit check",
  nodes: [
    { id: "start", type: "start", position: at(0), params: {} },
    { id: "people", type: "searchPeople", position: at(1), params: { keywords: "head of sales SaaS", network: "S", limit: 20 } },
    { id: "profile", type: "visitProfile", position: at(2), params: {} },
    {
      id: "ai", type: "aiPrompt", position: at(3),
      params: {
        prompt: "We sell an outbound sales tool to B2B SaaS companies with 10 to 500 people. Judge whether {{firstName}} is a good fit to pitch, and whether they would make or sign off on that purchase.",
        outputFields: [
          { name: "fit_score", type: "number", description: "0-100, how well they match the company size and role we sell to" },
          { name: "is_decision_maker", type: "boolean", description: "true if they would choose or approve a sales tool" },
          { name: "reason", type: "text", description: "one sentence citing their headline or experience" },
        ],
        outputKey: "ai",
      },
    },
    { id: "check", type: "condition", position: at(4), params: { rules: { match: "all", rules: [{ field: "ai.fit_score", op: "atLeast", value: 70 }, { field: "ai.is_decision_maker", op: "isTrue" }] } } },
    { id: "connect", type: "connect", position: at(5), params: { note: "", perDay: 20, perWeek: 100 } },
  ],
  edges: [edge("start", "people"), edge("people", "profile"), edge("profile", "ai"), edge("ai", "check"), edge("check", "connect", "true")],
};

// Discovery decides from the search results alone (headline and LinkedIn's matched-text snippet), so nobody's profile is opened just to be rejected. About three runs a day at 8 ± 2 invites stays under the 25-a-day cap with room for retries.
const topmateDiscovery = {
  key: "topmate-mentor-discovery",
  name: "Topmate Mentor Discovery",
  nodes: [
    { id: "schedule", type: "schedule", position: at(0), params: { everyMinutes: 240, fromHour: 9, toHour: 19, days: "everyday", jitterMinutes: 30 } },
    { id: "search", type: "searchPeople", position: at(1), params: { keywords: "topmate mentor", network: "any", mustMention: "topmate, topmate.io, mentor, mentoring, mentorship, career coach", skipContacted: "yes", limit: 12, maxPages: 10 } },
    {
      id: "connect", type: "connect", position: at(2),
      params: {
        note: "Hi {{firstName}}, I came across your profile and saw you mentor people on Topmate. We launched HireDue a month ago to help job seekers land interviews faster, and I would love to connect and learn how you guide your mentees through placements.",
        noteMode: "available", perRun: 8, perRunJitter: 2, perDay: 25, perWeek: 100, minGapSeconds: 45, maxGapSeconds: 120,
      },
    },
    { id: "tag", type: "crmUpdate", position: at(3), params: { stage: "keep", addTags: "topmate-mentor", note: "" } },
  ],
  edges: [edge("schedule", "search"), edge("search", "connect"), edge("connect", "tag")],
};

// Outreach works off the CRM tag Discovery sets, so it only ever writes to people Discovery invited; the sequence step holds every per-person decision.
const topmateOutreach = {
  key: "topmate-mentor-outreach",
  name: "Topmate Mentor Outreach",
  nodes: [
    { id: "schedule", type: "schedule", position: at(0), params: { everyMinutes: 180, fromHour: 9, toHour: 21, days: "everyday", jitterMinutes: 20 } },
    { id: "people", type: "crmSource", position: at(1), params: { stage: "any", tag: "topmate-mentor", limit: 500 } },
    {
      id: "sequence", type: "outreachSequence", position: at(2),
      params: {
        intro: "Hi {{firstName}},\n\nI have been interacting with your LinkedIn posts and comments for couple of weeks now. Last month I launched HireDue which helps users apply to 500 jobs everyday with customised resumes, even while they sleep.\n\nIn 3 weeks we have scaled to 1100 users with 400+ paid. Would love to connect and show you the product. Looking forward!",
        followUp1: "Hi {{firstName}}, just bumping this in case it got buried. Would you be open to a short chat about how your mentees handle placements?",
        followUp2: "Hi {{firstName}}, one last nudge from me. If helping your mentees land interviews faster sounds useful, I would be glad to show you HireDue. No worries if now is not a good time.",
        calendarMessage: "That is great, {{firstName}}! Here is my calendar, pick whichever slot works for you: {{calendarLink}}",
        cadenceDays: 2, checkEveryHours: 6, giveUpInviteDays: 21,
        replyPrompt: "A Topmate mentor is replying to our LinkedIn outreach about HireDue, a product that helps job seekers get interviews. Decide what they mean. interested: they are open to talking, want details or a demo, or ask when to meet. booked: they say they booked a slot or a call is set. not_interested: they decline, say it is not relevant, or ask us to stop. other: questions about price, partnerships or anything a person should answer.",
        perRun: 15, perDay: 40, minGapSeconds: 20, maxGapSeconds: 60,
      },
    },
  ],
  edges: [edge("schedule", "people"), edge("people", "sequence")],
};

module.exports = { templates: [hiringCommenters, b2bQualifiers, postEngagement, aiFitCheck, topmateDiscovery, topmateOutreach] };
