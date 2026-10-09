// Drives one logged-in LinkedIn page the way a person would: search, read comments, open profiles, connect, message. Every awkward fact about LinkedIn's markup lives here so the steps read as plain actions.

const { LINKEDIN, SELECTORS, PAUSE, TIMEOUT, LIMITS } = require("../constants.cjs");
const { parsePostStream, mergePosts, parsePersonCard, cleanProfileUrl, postedAt } = require("../domain/linkedinData.cjs");

const rand = (min, max) => Math.round(min + Math.random() * (max - min));
const pause = ([min, max]) => new Promise((r) => setTimeout(r, rand(min, max)));

class NotLoggedIn extends Error {}
// LinkedIn's weekly invitation cap; carrying on would only collect more refusals and draw attention to the account.
class InviteLimitReached extends Error {}

function createLinkedIn(page, { log = () => {}, shouldStop = () => false } = {}) {
  async function goto(url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) throw new NotLoggedIn(`LinkedIn sent the browser to ${new URL(page.url()).pathname}; log in again from the Accounts screen`);
  }

  // Camoufox animates the cursor on any Playwright mouse action, so a locator click already travels a human path; the pauses around it are ours.
  async function click(locator) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ delay: rand(40, 120) });
  }

  // Per-key timing from the desktop app's humanType: 70-160ms a key, longer after spaces, an occasional thinking pause. Newlines become Shift+Enter so a message is not sent half-written.
  async function type(locator, text) {
    await click(locator);
    for (const ch of text) {
      if (ch === "\n") await page.keyboard.press("Shift+Enter");
      else await page.keyboard.type(ch, { delay: rand(40, 100) });
      let gap = rand(70, 160);
      if (ch === " ") gap += rand(40, 120);
      if (Math.random() < 0.05) gap += rand(300, 800);
      await new Promise((r) => setTimeout(r, gap));
    }
  }

  async function scrollDown() {
    for (let i = 0, steps = rand(4, 7); i < steps; i++) {
      await page.mouse.wheel(0, rand(250, 600));
      await new Promise((r) => setTimeout(r, rand(150, 600)));
    }
  }

  async function firstVisible(selectors, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const s of selectors) {
        const loc = page.locator(s).filter({ visible: true }).first();
        if (await loc.count().catch(() => 0)) return loc;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  async function ensureLoggedIn() {
    await goto(LINKEDIN.FEED);
    const home = await page.waitForSelector(SELECTORS.NAV_HOME, { timeout: TIMEOUT.LOGIN_CHECK }).then(() => true, () => false);
    if (!home) throw new NotLoggedIn("This account is not logged in to LinkedIn; log in again from the Accounts screen");
    return page.evaluate(() => {
      const me = document.querySelector('a[href*="/in/"][href*="miniProfile"], .feed-identity-module a[href*="/in/"], a[href*="/in/"]');
      return me ? me.href : null;
    }).catch(() => null);
  }

  async function searchPosts({ keywords, sortBy = "date_posted", datePosted = "past-week", limit = 20 }) {
    const want = Math.min(Number(limit) || 20, LIMITS.SCRAPE_HARD_CAP);
    const chunks = [];
    const onResponse = async (res) => {
      if (!res.url().includes("linkedin.com")) return;
      const body = await res.text().catch(() => "");
      if (body.includes("postSlugUrl") || body.includes("urn:li:activity")) chunks.push(body);
    };
    page.on("response", onResponse);
    let cards = [];
    try {
      await goto(LINKEDIN.postSearch({ keywords, sortBy, datePosted }));
      await page.waitForSelector(SELECTORS.RESULT_ITEM, { timeout: 15_000 }).catch(() => {});
      await pause([1500, 2500]);
      for (let round = 0; round < 12 && !shouldStop(); round++) {
        cards = await page.evaluate(readPostCards, SELECTORS);
        log(`Post search: ${cards.length} posts on the page`);
        if (cards.length >= want) break;
        const before = cards.length;
        await scrollDown();
        await pause(PAUSE.BETWEEN_SCROLLS);
        if (round > 2 && (await page.evaluate(readPostCards, SELECTORS)).length === before) break;
      }
    } finally {
      page.off("response", onResponse);
    }
    const streamed = chunks.flatMap(parsePostStream);
    return mergePosts(cards, streamed).slice(0, want).map((p) => ({ kind: "post", ...p }));
  }

  // The home feed in the same post shape as searchPosts. Unverified markup: classic feed cards carry their activity urn in data-urn; if none are found the search-card reader is tried, with post links matched from the response stream as in searchPosts.
  async function readFeed({ limit = 20 } = {}) {
    const want = Math.min(Number(limit) || 20, LIMITS.SCRAPE_HARD_CAP);
    const chunks = [];
    const onResponse = async (res) => {
      if (!res.url().includes("linkedin.com")) return;
      const body = await res.text().catch(() => "");
      if (body.includes("postSlugUrl") || body.includes("urn:li:activity")) chunks.push(body);
    };
    const read = async () => {
      const classic = await page.evaluate(readFeedCards, SELECTORS);
      return classic.length ? classic : page.evaluate(readPostCards, SELECTORS);
    };
    page.on("response", onResponse);
    let cards = [];
    try {
      await goto(LINKEDIN.FEED);
      await page.waitForSelector(`${SELECTORS.FEED_POST}, ${SELECTORS.RESULT_ITEM}`, { timeout: 15_000 }).catch(() => {});
      await pause([1500, 2500]);
      for (let round = 0; round < 15 && !shouldStop(); round++) {
        cards = await read();
        log(`Feed: ${cards.length} posts on the page`);
        if (cards.length >= want) break;
        const before = cards.length;
        await scrollDown();
        await pause(PAUSE.BETWEEN_SCROLLS);
        if (round > 2 && (await read()).length === before) break;
      }
    } finally {
      page.off("response", onResponse);
    }
    const linked = mergePosts(cards.filter((c) => !c.postUrn), chunks.flatMap(parsePostStream));
    const posts = cards.map((c) => (c.postUrn ? { ...c, postUrl: LINKEDIN.postByUrn(c.postUrn), postedAt: postedAt(c.postUrn) } : linked.shift()));
    // A post reshared by two connections shows twice in the feed.
    const seen = new Set();
    return posts.filter((p) => { const k = p.postUrn || `${p.authorUrl}|${p.text.slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, want).map((p) => ({ kind: "post", ...p }));
  }

  async function commentersOf(post, { limit = 50 } = {}) {
    const url = post.postUrn ? LINKEDIN.postByUrn(post.postUrn) : post.postUrl;
    if (!url) return { people: [], note: "post has no link to open" };
    await goto(url);
    await pause(PAUSE.AFTER_PROFILE_OPEN);
    const want = Math.min(Number(limit) || 50, LIMITS.SCRAPE_HARD_CAP);
    let people = [];
    for (let round = 0; round < 15 && !shouldStop(); round++) {
      people = await page.evaluate(readComments, { COMMENT: SELECTORS.COMMENT, COMMENT_TEXT: SELECTORS.COMMENT_TEXT });
      if (people.length >= want) break;
      const more = page.getByRole("button", { name: SELECTORS.LOAD_MORE_COMMENTS }).filter({ visible: true }).first();
      if (!(await more.count())) { await scrollDown(); if (round > 1) break; continue; }
      await click(more);
      await pause([2000, 3500]);
    }
    const seen = new Set();
    const out = [];
    for (const c of people) {
      const profileUrl = cleanProfileUrl(c.profileUrl);
      if (!profileUrl || seen.has(profileUrl) || profileUrl === cleanProfileUrl(post.authorUrl)) continue;
      seen.add(profileUrl);
      out.push({ kind: "person", name: c.name, headline: c.headline, profileUrl, comment: c.text, source: { postUrl: post.postUrl, postText: post.text, postAuthor: post.authorName } });
    }
    return { people: out.slice(0, want), note: people.length ? null : "no comments found; the comment selectors may be stale" };
  }

  // accept decides on the search page itself (headline, snippet, CRM) so only people worth keeping count toward the limit, and paging goes deeper when early pages hold people already handled.
  async function searchPeople({ keywords, network = "S", limit = 20, accept = () => true, maxPages = 10 }) {
    const want = Math.min(Number(limit) || 20, LIMITS.SCRAPE_HARD_CAP);
    const found = new Map();
    const seen = new Set();
    for (let pageNo = 1; found.size < want && pageNo <= maxPages && !shouldStop(); pageNo++) {
      await goto(LINKEDIN.peopleSearch({ keywords, network, page: pageNo }));
      await page.waitForSelector('main a[href*="/in/"]', { timeout: 15_000 }).catch(() => {});
      await scrollDown();
      const cards = await page.evaluate(readPeopleCards);
      if (!cards.length) break;
      for (const c of cards) {
        const p = parsePersonCard(c.lines, c.href);
        if (!p.profileUrl || !p.name || seen.has(p.profileUrl)) continue;
        seen.add(p.profileUrl);
        const person = { kind: "person", ...p };
        if (accept(person)) found.set(p.profileUrl, person);
      }
      log(`People search page ${pageNo}: ${seen.size} looked at, ${found.size} kept`);
      await pause(PAUSE.BETWEEN_PAGES);
    }
    return [...found.values()].slice(0, want);
  }

  async function readProfile(profileUrl) {
    await goto(profileUrl);
    await page.waitForSelector(SELECTORS.TOPCARD, { timeout: 15_000 });
    await pause(PAUSE.AFTER_PROFILE_OPEN);
    // Experience loads lazily as it scrolls into view.
    await page.locator(SELECTORS.EXPERIENCE).first().scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await pause([1000, 2000]);
    const data = await page.evaluate(readTopcard, SELECTORS);
    await page.evaluate(() => window.scrollTo(0, 0));
    return data;
  }

  async function connectState() {
    return page.evaluate(readTopcard, SELECTORS).then((d) => d, () => null);
  }

  // Strategies in the order the desktop app found reliable: the named invite link, any "to connect" link, a Connect button, then the More menu.
  async function openInviteDialog(name) {
    const top = page.locator(SELECTORS.TOPCARD).first();
    const direct = [
      top.locator(`a[aria-label="Invite ${name} to connect"], button[aria-label="Invite ${name} to connect"]`),
      top.locator('a[aria-label*="to connect"], button[aria-label*="to connect"]'),
      top.getByRole("button", { name: /^Connect$/ }),
    ];
    for (const loc of direct) {
      const el = loc.filter({ visible: true }).first();
      if (await el.count()) { await click(el); await pause(PAUSE.AFTER_CONNECT_CLICK); return true; }
    }
    const more = top.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).last();
    if (!(await more.count())) return false;
    await click(more);
    await pause(PAUSE.AFTER_MORE_CLICK);
    const item = page.locator(`[aria-label="Invite ${name} to connect"]`).or(page.getByRole("menuitem", { name: /Connect/i })).filter({ visible: true }).first();
    if (!(await item.count())) { await page.keyboard.press("Escape"); return false; }
    await click(item);
    await pause(PAUSE.AFTER_CONNECT_CLICK);
    return true;
  }

  async function assertNoInviteLimit() {
    const body = await page.locator("body").innerText().catch(() => "");
    if (/weekly invitation limit|reached the weekly limit|too many pending invitations/i.test(body)) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new InviteLimitReached("LinkedIn says this account has reached its weekly invitation limit");
    }
  }

  // Returns sent, pending, connected, unavailable or unverified. Only "sent" counts against the daily cap and only after the profile shows Pending.
  // Free accounts get a handful of personalised notes a month; after that Add a note opens a Premium upsell instead of a text box.
  async function noteBlockedByUpsell() {
    await pause([1200, 1800]);
    const box = await page.locator('textarea[name="message"], textarea#custom-message, [role="dialog"] textarea').filter({ visible: true }).count();
    if (box) return false;
    const body = await page.locator("body").innerText().catch(() => "");
    return SELECTORS.NOTE_UPSELL.test(body);
  }

  async function sendWithoutNote(name) {
    let send = page.getByRole("button", { name: /send without a note|send now/i }).filter({ visible: true }).first();
    if (!(await send.count())) {
      await page.keyboard.press("Escape").catch(() => {});
      await pause([800, 1400]);
      if (!(await openInviteDialog(name))) return false;
      send = page.getByRole("button", { name: /send without a note|send now/i }).filter({ visible: true }).first();
      if (!(await send.count())) return false;
    }
    await click(send);
    return true;
  }

  // Returns { status, noteUsed, noteUnavailable }. With fallbackWithoutNote, an account that cannot add notes still sends the invite, bare, and says so.
  async function connect(person, note, { fallbackWithoutNote = false } = {}) {
    const before = await readProfile(person.profileUrl);
    if (before.isPending) return { status: "pending", profile: before };
    if (before.degree === "1st") return { status: "connected", profile: before };
    const name = before.name || person.name;
    if (!(await openInviteDialog(name))) return { status: "unavailable", profile: before };
    await assertNoInviteLimit();

    let noteUsed = false;
    let noteUnavailable = false;
    if (note) {
      const addNote = page.getByRole("button", { name: /add a note/i }).filter({ visible: true }).first();
      if (await addNote.count()) {
        await click(addNote);
        if (await noteBlockedByUpsell()) { noteUnavailable = true; await page.keyboard.press("Escape").catch(() => {}); await pause([800, 1400]); }
        else {
          const box = page.locator('textarea[name="message"], textarea#custom-message, [role="dialog"] textarea').filter({ visible: true }).first();
          await box.waitFor({ timeout: 6000 });
          await type(box, note);
          await click(page.getByRole("button", { name: /^send( invitation)?$/i }).filter({ visible: true }).first());
          noteUsed = true;
        }
      } else noteUnavailable = true;
      if (noteUnavailable && !fallbackWithoutNote) {
        await page.keyboard.press("Escape").catch(() => {});
        return { status: "unverified", profile: before, noteUnavailable, detail: "this account cannot add a note right now; nothing was sent" };
      }
    }
    if (!noteUsed && !(await sendWithoutNote(name))) return { status: "unverified", profile: before, noteUnavailable, detail: "could not find Send without a note" };
    await pause(PAUSE.AFTER_SEND);
    await assertNoInviteLimit();
    // Verify on the profile, not the dialog: Pending on the top card is the only proof LinkedIn accepted the invite.
    const after = await connectState();
    return { status: after?.isPending ? "sent" : "unverified", profile: { ...before, ...after }, noteUsed, noteUnavailable };
  }

  async function closeOverlays() {
    for (let i = 0; i < 4; i++) {
      const bubble = page.locator(`${SELECTORS.OVERLAY} button`).filter({ hasText: /close your/i }).first();
      if (!(await bubble.count())) return;
      await bubble.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  // Opens the conversation with a 1st-degree connection; the compose link lands in the existing thread when there is one. Returns { profile, editor } or { failure }.
  async function openThread(person) {
    const profile = await readProfile(person.profileUrl);
    if (profile.degree !== "1st") return { failure: { status: "not_connected", profile } };
    await closeOverlays();
    if (profile.profileUrn) await goto(LINKEDIN.composeTo(profile.profileUrn));
    else {
      const btn = page.locator(SELECTORS.TOPCARD).first().getByRole("link", { name: /^message/i }).or(page.locator(SELECTORS.TOPCARD).first().getByRole("button", { name: /^message/i })).filter({ visible: true }).first();
      if (!(await btn.count())) return { failure: { status: "failed", profile, detail: "no Message button on the profile" } };
      await click(btn);
    }
    const editor = await firstVisible(SELECTORS.EDITOR, 10_000);
    if (!editor) return { failure: { status: "failed", profile, detail: "the message box never opened" } };
    return { profile, editor };
  }

  // Returns { messages: [{ fromMe, text, at }] } oldest first, or { messages: null, reason } when the conversation could not be read; a failure never comes back as an empty list.
  async function readThread(person) {
    const opened = await openThread(person);
    if (opened.failure) return { messages: null, reason: opened.failure.status === "not_connected" ? "not a 1st-degree connection, so there is no conversation to open" : opened.failure.detail };
    await page.waitForSelector(SELECTORS.THREAD_LIST, { timeout: 5000 }).catch(() => {});
    await pause([1000, 2000]);
    const messages = await page.evaluate(readThreadEvents, SELECTORS).catch(() => null);
    return messages ? { messages } : { messages: null, reason: "no message list on the conversation page; the thread selectors may be stale" };
  }

  // Returns sent, not_connected, already_messaged or failed. A thread with earlier messages is never written to, so a rerun cannot double-message someone; a follow-up passes intoExistingThread because writing there is the point, and it is still only counted once the composer clears.
  async function sendMessage(person, text, { intoExistingThread = false } = {}) {
    const opened = await openThread(person);
    if (opened.failure) return opened.failure;
    const { profile, editor } = opened;
    if (!intoExistingThread) {
      const history = await page.locator(".msg-s-message-list__event, .msg-s-event-listitem").count().catch(() => 0);
      if (history > 0) return { status: "already_messaged", profile };
    } else if ((await editor.textContent().catch(() => "")).trim()) {
      // LinkedIn keeps an unsent draft per thread; typing after it would send the draft and the follow-up as one message.
      await click(editor);
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      if ((await editor.textContent().catch(() => "")).trim()) return { status: "failed", profile, detail: "an old draft in the message box could not be cleared" };
    }

    await type(editor, text);
    const send = await firstVisible(SELECTORS.SEND, 4000);
    if (!send) return { status: "failed", profile, detail: "no Send button" };
    await page.waitForFunction((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true", await send.elementHandle(), { timeout: 4000 }).catch(() => {});
    await click(send);
    await pause(PAUSE.AFTER_SEND);
    // LinkedIn clears the composer once the message is accepted; text still in it means it did not go.
    const left = (await editor.textContent().catch(() => "")).trim();
    return left ? { status: "failed", profile, detail: "the message stayed in the box after Send" } : { status: "sent", profile };
  }

  async function openPost(post) {
    const url = post.postUrn ? LINKEDIN.postByUrn(post.postUrn) : post.postUrl;
    if (!url) throw new Error("the post has no link to open");
    await goto(url);
    await page.waitForSelector("main", { timeout: 15_000 });
    await pause(PAUSE.AFTER_PROFILE_OPEN);
    return page.locator("main").first();
  }

  // The first visible Like-family button on a single-post page belongs to the post itself; comment Like buttons sit below it.
  async function likeButton(main) {
    const btn = main.getByRole("button", { name: SELECTORS.LIKE_BUTTON }).filter({ visible: true }).first();
    return (await btn.count()) ? btn : null;
  }

  // Returns sent, already or unverified. Checks aria-pressed on the button, which LinkedIn flips once the reaction is saved.
  async function like(post, reaction = "like") {
    const main = await openPost(post);
    const btn = await likeButton(main);
    if (!btn) return { status: "failed", detail: "no Like button on the post" };
    if ((await btn.getAttribute("aria-pressed")) === "true") return { status: "already" };
    const handle = await btn.elementHandle();
    if (reaction === "like") await click(btn);
    else {
      // The reaction tray opens on hover and closes if the cursor leaves too soon.
      await btn.hover();
      await pause([1200, 1800]);
      const choice = page.getByRole("button", { name: new RegExp(`^${SELECTORS.REACTIONS[reaction] || "Like"}$`, "i") }).filter({ visible: true }).first();
      if (!(await choice.count())) return { status: "failed", detail: `the ${reaction} reaction did not appear` };
      await click(choice);
    }
    await pause([1500, 2500]);
    const pressed = await handle.getAttribute("aria-pressed").catch(() => null);
    return { status: pressed === "true" ? "sent" : "unverified" };
  }

  // Returns sent or unverified. Proof is the comment's opening words showing up in the post's comment list.
  async function comment(post, text) {
    const main = await openPost(post);
    let editor = await firstVisible(SELECTORS.COMMENT_EDITOR, 2000);
    if (!editor) {
      const open = main.getByRole("button", { name: /^comment$/i }).filter({ visible: true }).first();
      if (!(await open.count())) return { status: "failed", detail: "no Comment button on the post" };
      await click(open);
      editor = await firstVisible(SELECTORS.COMMENT_EDITOR, 6000);
    }
    if (!editor) return { status: "failed", detail: "the comment box never opened" };
    await type(editor, text);
    await pause([600, 1200]);
    let submit = editor.locator("xpath=ancestor::form[1]").locator('button[type="submit"], button:has-text("Comment"), button:has-text("Post")').filter({ visible: true }).first();
    if (!(await submit.count())) submit = await firstVisible(SELECTORS.COMMENT_SUBMIT, 3000);
    if (!submit) return { status: "failed", detail: "no button to post the comment" };
    await click(submit);
    const opening = text.slice(0, 40);
    const shown = await page.waitForFunction(({ sel, opening }) => [...document.querySelectorAll(sel)].some((c) => c.innerText.includes(opening)), { sel: SELECTORS.COMMENT, opening }, { timeout: 10_000 }).then(() => true, () => false);
    return { status: shown ? "sent" : "unverified" };
  }

  // Returns sent or unverified. Proof is LinkedIn's confirmation toast; a repost leaves nothing on the original post to check.
  async function repost(post, thoughts) {
    const main = await openPost(post);
    const btn = main.getByRole("button", { name: /repost/i }).filter({ visible: true }).first();
    if (!(await btn.count())) return { status: "failed", detail: "no Repost button on the post" };
    await click(btn);
    await pause([1200, 2000]);
    if (thoughts) {
      const withThoughts = page.getByText(/repost with your thoughts/i).filter({ visible: true }).first();
      if (!(await withThoughts.count())) return { status: "failed", detail: "no Repost with your thoughts option" };
      await click(withThoughts);
      const editor = await firstVisible(SELECTORS.SHARE_EDITOR, 8000);
      if (!editor) return { status: "failed", detail: "the post editor never opened" };
      await type(editor, thoughts);
      await pause([800, 1500]);
      await click(page.locator('[role="dialog"]').getByRole("button", { name: /^post$/i }).filter({ visible: true }).first());
    } else {
      const plain = page.getByRole("menuitem", { name: /^repost(?! with)/i }).or(page.getByText(/^Repost$/)).filter({ visible: true }).first();
      if (!(await plain.count())) return { status: "failed", detail: "no plain Repost option" };
      await click(plain);
    }
    const done = await page.getByText(SELECTORS.REPOST_DONE).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    return { status: done ? "sent" : "unverified" };
  }

  // Follows a company or school page, a person, or a post's author. Returns sent, already or unverified; proof is a Following button where Follow was.
  async function follow(item) {
    const url = item.pageUrl || item.profileUrl || item.authorUrl;
    if (!url) throw new Error("nothing to follow: no page or profile link");
    await goto(url);
    await page.waitForSelector("main", { timeout: 15_000 });
    await pause(PAUSE.AFTER_PROFILE_OPEN);
    const isPerson = /\/in\//.test(url);
    const scope = isPerson ? page.locator(SELECTORS.TOPCARD).first() : page.locator("main").first();
    const following = () => scope.getByRole("button", { name: /^following\b|^unfollow\b/i }).filter({ visible: true }).count();
    if (await following()) return { status: "already" };
    let btn = scope.getByRole("button", { name: /^follow\b/i }).filter({ visible: true }).first();
    if (!(await btn.count()) && isPerson) {
      const more = scope.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).last();
      if (await more.count()) {
        await click(more);
        await pause(PAUSE.AFTER_MORE_CLICK);
        btn = page.getByRole("menuitem", { name: /^follow\b/i }).or(page.getByRole("button", { name: /^follow\b/i })).filter({ visible: true }).first();
      }
    }
    if (!(await btn.count())) return { status: "failed", detail: "no Follow button" };
    await click(btn);
    await pause([1500, 2500]);
    // The More menu closes after the click, so for a person the proof is the Following state on reload.
    if (isPerson && !(await following())) { await page.reload({ waitUntil: "domcontentloaded" }); await pause([2000, 3000]); }
    return { status: (await following()) ? "sent" : "unverified" };
  }

  // Long gaps between invites are cut into short waits so Stop takes effect within a second instead of after two minutes.
  async function wait(range = PAUSE.BETWEEN_PEOPLE) {
    const until = Date.now() + rand(range[0], range[1]);
    while (Date.now() < until && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }

  return { ensureLoggedIn, searchPosts, readFeed, commentersOf, searchPeople, readProfile, connect, sendMessage, readThread, like, comment, repost, follow, pause: wait };
}

// ---- functions below run inside the page ----

// Classic feed cards; ads are dropped because acting on them spends allowance on a brand, not a person.
function readFeedCards(S) {
  return [...document.querySelectorAll(S.FEED_POST)].map((card) => {
    const actor = card.querySelector(S.FEED_ACTOR);
    if (/(^|\n)\s*Promoted\s*($|\n)/.test(actor?.innerText || "")) return null;
    const link = actor?.querySelector('a[href*="/in/"], a[href*="/company/"]') || card.querySelector('a[href*="/in/"], a[href*="/company/"]');
    const authorName = card.querySelector(S.FEED_ACTOR_NAME)?.innerText?.split("\n")[0]?.trim() || link?.innerText?.split("\n")[0]?.trim() || null;
    const authorHeadline = card.querySelector(S.FEED_ACTOR_HEADLINE)?.innerText?.split("\n")[0]?.trim() || null;
    const text = card.querySelector(S.FEED_TEXT)?.innerText?.replace(/\n?…\s*(see )?more\s*$/i, "").trim() || "";
    const postUrn = card.getAttribute("data-urn") || card.getAttribute("data-id") || null;
    return { authorName, authorUrl: link ? link.href.split("?")[0] : null, authorHeadline, text, postUrn };
  }).filter((c) => c && c.text && c.authorUrl && /^urn:li:activity:\d+$/.test(c.postUrn || ""));
}

function readPostCards(S) {
  return [...document.querySelectorAll(S.RESULT_ITEM)].map((item) => {
    const text = item.querySelector(S.POST_TEXT)?.innerText?.replace(/\n?…\s*more\s*$/, "").trim() || "";
    const link = item.querySelector('a[href*="/in/"]');
    const menu = item.querySelector(S.POST_MENU);
    const authorName = menu?.getAttribute("aria-label")?.replace(/^Open control menu for post by\s*/, "").trim() || link?.innerText?.split("\n")[0]?.trim() || null;
    const bio = item.querySelector('a[href*="/in/"][componentkey^="auto-component"]');
    const headline = bio ? bio.querySelectorAll("p")[1]?.innerText?.trim() || null : null;
    return { authorName, authorUrl: link ? link.href.split("?")[0] : null, authorHeadline: headline, text };
  }).filter((c) => c.text && c.authorUrl);
}

function readComments(S) {
  return [...document.querySelectorAll(S.COMMENT)].map((c) => {
    const link = c.querySelector('a[href*="/in/"]');
    const nameEl = c.querySelector(".comments-comment-meta__description-title, .comments-post-meta__name-text, [aria-hidden='true']");
    const label = link?.getAttribute("aria-label")?.match(/View (.+?)['’]s/)?.[1];
    const name = (label || nameEl?.innerText || link?.innerText || "").split("\n")[0].trim();
    const headline = c.querySelector(".comments-comment-meta__description-subtitle, .comments-post-meta__headline")?.innerText?.trim() || null;
    const text = c.querySelector(S.COMMENT_TEXT)?.innerText?.trim() || "";
    return { name, headline, profileUrl: link?.href || null, text };
  }).filter((c) => c.profileUrl && c.name);
}

function readPeopleCards() {
  const main = document.querySelector("main") || document.body;
  const cards = [...main.querySelectorAll('[role="listitem"], li.reusable-search__result-container')];
  return cards.map((card) => {
    const link = card.querySelector('a[href*="/in/"]');
    if (!link) return null;
    const lines = card.innerText.split("\n");
    return { href: link.href, lines };
  }).filter(Boolean);
}

// null when there is no message list at all, so the caller can tell "could not read" from "nobody wrote"; an event's sender is marked only on the other person's messages.
function readThreadEvents(S) {
  const list = document.querySelector(S.THREAD_LIST);
  if (!list) return null;
  const selectors = S.THREAD_EVENT.split(",").map((s) => s.trim());
  const events = selectors.map((s) => [...list.querySelectorAll(s)]).find((found) => found.length) || [];
  return events.map((el) => {
    const fromOther = el.classList.contains(S.THREAD_FROM_OTHER) || !!el.querySelector(`.${S.THREAD_FROM_OTHER}`);
    const stamp = el.querySelector(S.THREAD_TIME)?.getAttribute("datetime");
    const at = stamp ? Date.parse(stamp) : NaN;
    return { fromMe: !fromOther, text: el.querySelector(S.THREAD_BODY)?.innerText?.trim() || "", at: Number.isFinite(at) ? at : null };
  });
}

function readTopcard(S) {
  const top = document.querySelector(S.TOPCARD);
  if (!top) return { name: null };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const name = top.querySelector("h1, h2")?.innerText?.trim() || null;
  const ps = [...top.querySelectorAll("p")].map((p) => p.innerText.trim()).filter(Boolean);
  const headline = ps.filter((t) => t.length > 10 && !/connections?$/.test(t)).sort((a, b) => b.length - a.length)[0] || null;
  const location = ps.find((t) => /,\s*\w/.test(t) && !/·|connections|Contact/.test(t)) || null;
  // LinkedIn renders both a 1st and a 2nd badge and hides one with CSS, so only a visible badge counts.
  let degree = null;
  for (const el of top.querySelectorAll("p, span")) {
    const m = el.innerText?.trim().match(/(?:^|·\s*)(1st|2nd|3rd\+?)(?:\s+degree)?(?:\s+connection)?\s*$/i);
    if (m && visible(el)) { degree = m[1].toLowerCase(); break; }
  }
  const controls = [...top.querySelectorAll("a, button")].filter(visible);
  const isPending = controls.some((el) => el.innerText.trim() === "Pending" || /^Pending,/i.test(el.getAttribute("aria-label") || "") || /withdraw invitation/i.test(el.getAttribute("aria-label") || ""));
  const msg = top.querySelector('a[href*="messaging/compose"]');
  const profileUrn = msg?.href.match(/fsd_profile%3A(ACoAA[A-Za-z0-9_-]+)/)?.[1] || msg?.href.match(/recipient=(ACoAA[A-Za-z0-9_-]+)/)?.[1] || null;
  const about = [...document.querySelectorAll("section")].find((s) => /^About/.test(s.querySelector("h2")?.innerText?.trim() || ""));
  const exp = document.querySelector(S.EXPERIENCE) || [...document.querySelectorAll("section")].find((s) => /^Experience/.test(s.querySelector("h2")?.innerText?.trim() || ""));
  const collapse = (t) => (t || "").split("\n").map((l) => l.trim()).filter((l, i, a) => l && l !== a[i - 1]).join("\n");
  return {
    name, headline, location, degree, isPending, profileUrn,
    about: collapse(about?.innerText).replace(/^About\n?/, "").slice(0, 2000) || null,
    experience: collapse(exp?.innerText).replace(/^Experience\n?/, "").slice(0, 4000) || null,
  };
}

module.exports = { createLinkedIn, NotLoggedIn, InviteLimitReached };
