// Every LinkedIn URL, selector, pause and cap the app uses. Selectors marked "verified" were lifted from hiredue-desktop-application, where they run in production; "unverified" ones were written without a logged-in session to check them against.

const LINKEDIN = {
  FEED: "https://www.linkedin.com/feed/",
  LOGIN: "https://www.linkedin.com/checkpoint/lg/sign-in-another-account",
  // LinkedIn's search filters take JSON arrays URL-encoded into the query string (the desktop app's scrapeConnect flow builds the same shape).
  postSearch: ({ keywords, sortBy, datePosted }) => {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keywords)}&origin=FACETED_SEARCH&sortBy=%5B%22${sortBy}%22%5D`;
    if (datePosted && datePosted !== "any") url += `&datePosted=%5B%22${datePosted}%22%5D`;
    return url;
  },
  // network: F = 1st, S = 2nd, O = 3rd and beyond, the codes LinkedIn's own people-search filter writes into the URL.
  peopleSearch: ({ keywords, network, page }) => {
    let url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=FACETED_SEARCH`;
    if (network && network !== "any") url += `&network=%5B%22${network}%22%5D`;
    if (page > 1) url += `&page=${page}`;
    return url;
  },
  postByUrn: (urn) => `https://www.linkedin.com/feed/update/${urn}/`,
  composeTo: (profileUrn) => `https://www.linkedin.com/messaging/compose/?recipient=${profileUrn}`,
};

const SELECTORS = {
  // verified: login state
  NAV_HOME: '[aria-label^="Home"]',
  LOGIN_FORM: '#username, input[type="password"], [data-sdui-screen*="Login"]',
  // verified: search result cards for posts
  RESULT_ITEM: '[role="listitem"]',
  POST_TEXT: '[data-testid="expandable-text-box"]',
  POST_MENU: '[aria-label^="Open control menu for post by"]',
  // verified: profile top card
  TOPCARD: '[componentkey*="Topcard"]',
  EXPERIENCE: 'section[componentkey*="ExperienceTopLevelSection"]',
  // unverified: comment threads on a post page; the classic class names first, the SDUI urn attribute second
  COMMENT: 'article.comments-comment-entity, article.comments-comment-item, [data-id^="urn:li:comment"], [componentkey*="comment" i][role="article"]',
  COMMENT_TEXT: '.comments-comment-item__main-content, .comments-comment-entity__content, [data-testid="expandable-text-box"], .update-components-text',
  LOAD_MORE_COMMENTS: /load more comments|show more comments|see more comments|load previous replies/i,
  // verified: messaging composer
  EDITOR: ['div.msg-form__contenteditable[contenteditable="true"]', '.msg-form__msg-content-container div[contenteditable="true"]', 'div[role="textbox"][aria-label*="Write a message" i]', 'div[role="textbox"][contenteditable="true"]'],
  SEND: ['.msg-form__send-button', 'button[type="submit"]:has-text("Send")'],
  // verified: overlays left open by earlier runs steal focus from the composer
  OVERLAY: ".msg-overlay-conversation-bubble",
  // unverified: reading a conversation for follow-ups and Check replies; written from LinkedIn's classic messaging markup without a logged-in session, so a miss returns "could not read", never "no reply"
  THREAD_LIST: ".msg-s-message-list, .msg-s-message-list-content, [data-view-name*='message-list' i]",
  THREAD_EVENT: "li.msg-s-message-list__event, .msg-s-event-listitem",
  THREAD_FROM_OTHER: "msg-s-event-listitem--other",
  THREAD_BODY: ".msg-s-event-listitem__body, .msg-s-event__content, p",
  THREAD_TIME: "time[datetime], .msg-s-message-group__timestamp",
  // unverified: the social bar under a post, and the boxes its buttons open
  LIKE_BUTTON: /^(react )?like$|^like\b/i,
  REACTIONS: { like: "Like", celebrate: "Celebrate", support: "Support", love: "Love", insightful: "Insightful", funny: "Funny" },
  COMMENT_EDITOR: ['.comments-comment-box__form div[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[role="textbox"][aria-label*="comment" i]', '[contenteditable="true"][aria-placeholder*="comment" i]'],
  COMMENT_SUBMIT: ["button.comments-comment-box__submit-button", "button.comments-comment-box__submit-button--cr", 'form.comments-comment-box__form button[type="submit"]'],
  SHARE_EDITOR: ['.share-creation-state__text-editor div[contenteditable="true"]', '[role="dialog"] div[role="textbox"][contenteditable="true"]'],
  // unverified: the Premium upsell LinkedIn shows instead of a note box once a free account's monthly personalised notes are used up
  NOTE_UPSELL: /premium|personali[sz]ed invitations|personali[sz]ed notes|free personali[sz]ed|monthly limit/i,
  REPOST_DONE: /repost successful|reposted|post successful|your post (is|was) (shared|posted)/i,
  // unverified: home feed cards (the classic feed-shared-update markup); when none match, readFeed falls back to RESULT_ITEM and POST_TEXT above
  FEED_POST: 'div.feed-shared-update-v2[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]',
  FEED_ACTOR: ".update-components-actor, .feed-shared-actor",
  FEED_ACTOR_NAME: ".update-components-actor__title span[aria-hidden='true'], .update-components-actor__name, .feed-shared-actor__name",
  FEED_ACTOR_HEADLINE: ".update-components-actor__description span[aria-hidden='true'], .update-components-actor__description, .feed-shared-actor__description",
  FEED_TEXT: ".update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, [data-testid=\"expandable-text-box\"]",
};

// Uniform random pauses in ms, [min, max]. The values are the desktop app's, which have run on real accounts without restriction.
const PAUSE = {
  BETWEEN_PEOPLE: [2000, 4000],
  AFTER_PROFILE_OPEN: [2500, 3500],
  AFTER_CONNECT_CLICK: [1500, 2500],
  AFTER_MORE_CLICK: [2000, 3000],
  BETWEEN_SCROLLS: [5500, 10500],
  AFTER_SEND: [2000, 3000],
  BETWEEN_PAGES: [4000, 7000],
};

const TIMEOUT = {
  NAVIGATION: 30_000,
  LOGIN_CHECK: 20_000,
  // Manual login covers two-factor and captcha, which take a person a few minutes.
  MANUAL_LOGIN: 5 * 60_000,
  LLM: 60_000,
};

// Defaults for the Connect and Message steps; each step can lower them. The desktop app ships 30 invites a day and LinkedIn starts warning accounts near 100 a week.
const LIMITS = {
  CONNECT_PER_DAY: 20,
  CONNECT_PER_WEEK: 100,
  MESSAGE_PER_DAY: 30,
  // LinkedIn rejects an invitation note longer than this.
  NOTE_MAX_CHARS: 300,
  // A ceiling on any single scrape so a typo in a step's limit cannot keep a browser scrolling for an hour.
  SCRAPE_HARD_CAP: 200,
  // Engagement defaults are conservative guesses, not measured limits: comments and reposts are the most visible to other people, so they get the lowest caps.
  FOLLOW_PER_DAY: 30,
  LIKE_PER_DAY: 50,
  COMMENT_PER_DAY: 15,
  REPOST_PER_DAY: 5,
  // How long an account that hit the Premium upsell on Add a note skips notes before trying one again.
  NOTE_RECHECK_DAYS: 7,
  // A guess kept below MESSAGE_PER_DAY: follow-ups land in threads that went unanswered, the messages most likely to be reported.
  FOLLOWUP_PER_DAY: 20,
};

const TRIGGERS = {
  // How often the scheduler checks whether any schedule or API poll is due.
  // OUTREACH_TICK_MS exists for the end-to-end tests, which cannot wait 30 seconds per trigger check.
  TICK_MS: Number(process.env.OUTREACH_TICK_MS) || 30_000,
  // An API polled more often than this gains little and risks hitting the API's own rate limit.
  POLL_MIN_MINUTES: 5,
  // A due trigger whose account is busy with another run tries again after this long.
  BUSY_RETRY_MINUTES: 5,
  API_TIMEOUT_MS: 20_000,
};

// The browser build hiredue-desktop-application pins in electron/browser/camoufox.pin.json; both apps share one install in the OS cache.
const CAMOUFOX_PIN = { version: "152.0.4", release: "beta.30" };

// LiteLLM proxy in front of the Azure models; any OpenAI-compatible endpoint works.
const LLM_DEFAULTS = { baseUrl: "https://ai.hiredue.com/v1", model: "deepseek-v4-flash" };

const FOLLOWUP = {
  // A follow-up that could not read or open its thread tries again after this long, so a slow page at 3pm does not cost the person their follow-up.
  RETRY_HOURS: 6,
  // After this many attempts in a row the row is marked failed; by then the selectors or the person's profile are the problem, not timing.
  MAX_ATTEMPTS: 3,
};

module.exports = { LINKEDIN, SELECTORS, PAUSE, TIMEOUT, LIMITS, TRIGGERS, CAMOUFOX_PIN, LLM_DEFAULTS, FOLLOWUP };
