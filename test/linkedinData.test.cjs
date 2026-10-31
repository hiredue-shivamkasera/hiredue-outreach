const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePostStream, mergePosts, parsePersonCard, cleanProfileUrl, postedAt, parseTopcardLines } = require("../electron/domain/linkedinData.cjs");

const streamChunk = String.raw`{\"urn\":\"urn:li:activity:7381234567890123456\",\"postSlugUrl\":\"https:\/\/www.linkedin.com\/posts\/asha-rao_hiring-react-devs-activity-7381234567890123456-AbCd\"}`;

test("the post stream yields the post link and its activity id", () => {
  assert.deepEqual(parsePostStream(streamChunk), [{ postUrl: "https://www.linkedin.com/posts/asha-rao_hiring-react-devs-activity-7381234567890123456-AbCd", activityId: "7381234567890123456" }]);
});

test("a card is joined to its streamed post through the author's vanity name", () => {
  const cards = [{ authorName: "Asha Rao", authorUrl: "https://www.linkedin.com/in/asha-rao/", text: "We are hiring react devs" }];
  const [post] = mergePosts(cards, parsePostStream(streamChunk));
  assert.equal(post.postUrn, "urn:li:activity:7381234567890123456");
  assert.match(post.postUrl, /asha-rao_hiring/);
});

// The comment step opens each post by its URL, so a card that cannot be joined must say so with null rather than borrow another post's link.
test("a card with no streamed match keeps a null post link", () => {
  const [post] = mergePosts([{ authorUrl: "https://www.linkedin.com/in/someone-else/", text: "x" }], parsePostStream(streamChunk));
  assert.equal(post.postUrl, null);
  assert.equal(post.postUrn, null);
});

test("postedAt reads the timestamp packed into an activity id", () => {
  assert.equal(postedAt("urn:li:activity:7381234567890123456").slice(0, 4), "2025");
  assert.equal(postedAt(null), null);
});

test("a people card's lines become name, degree, headline and location", () => {
  const person = parsePersonCard(["Asha Rao", "View Asha Rao’s profile", "• 2nd", "Founder at Loop | B2B SaaS", "Bengaluru, Karnataka, India", "12 mutual connections", "Connect"], "https://www.linkedin.com/in/asha-rao?miniProfileUrn=xyz");
  assert.deepEqual(person, { name: "Asha Rao", headline: "Founder at Loop | B2B SaaS", location: "Bengaluru, Karnataka, India", degree: "2nd", profileUrl: "https://www.linkedin.com/in/asha-rao/", snippet: null });
});

test("a degree glued to the name line is split off", () => {
  const person = parsePersonCard(["Ravi Kumar • 1st", "CTO", "Pune"], "/in/ravik/");
  assert.equal(person.name, "Ravi Kumar");
  assert.equal(person.degree, "1st");
});

test("cleanProfileUrl drops tracking parameters and normalises the host", () => {
  assert.equal(cleanProfileUrl("/in/meera-s?trk=abc"), "https://www.linkedin.com/in/meera-s/");
  assert.equal(cleanProfileUrl("https://www.linkedin.com/company/acme/"), null);
});

const { itemFromUrl } = require("../electron/domain/linkedinData.cjs");

test("itemFromUrl recognises profiles, pages and posts", () => {
  assert.deepEqual(itemFromUrl("linkedin.com/in/asha-rao/"), { kind: "person", profileUrl: "https://www.linkedin.com/in/asha-rao/" });
  assert.deepEqual(itemFromUrl("https://www.linkedin.com/company/hiredue/about/"), { kind: "page", pageUrl: "https://www.linkedin.com/company/hiredue/" });
  assert.deepEqual(itemFromUrl("https://www.linkedin.com/showcase/acme-labs"), { kind: "page", pageUrl: "https://www.linkedin.com/showcase/acme-labs/" });
  assert.deepEqual(itemFromUrl("https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/"), { kind: "post", postUrn: "urn:li:activity:7381234567890123456", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/" });
  assert.equal(itemFromUrl("https://www.linkedin.com/posts/asha-rao_hiring-activity-7381234567890123456-AbCd").postUrn, "urn:li:activity:7381234567890123456");
});

test("itemFromUrl returns null for anything that is not a LinkedIn profile, page or post", () => {
  assert.equal(itemFromUrl("https://example.com/in/asha"), null);
  assert.equal(itemFromUrl("https://www.linkedin.com/jobs/view/123"), null);
  assert.equal(itemFromUrl(""), null);
});

// Search results show why a person matched ("Current: Mentor at Topmate"), which is often the only place the keyword appears without opening the profile.
test("the matched-text lines under a search card are kept as the snippet", () => {
  const person = parsePersonCard(["Ravi Kumar", "• 2nd", "Engineering Manager at Swiggy", "Bengaluru", "Current: Mentor at Topmate · topmate.io/ravik", "Summary: I help freshers crack placements", "Connect"], "/in/ravik/");
  assert.equal(person.headline, "Engineering Manager at Swiggy");
  assert.equal(person.snippet, "Current: Mentor at Topmate · topmate.io/ravik\nSummary: I help freshers crack placements");
});

// Taken from a live profile on 2026-11-01: the old longest-line rule picked the city, because "Attended UBS" is shorter than "Mumbai, Maharashtra, India".
test("a short headline is still the headline, not the longer location under it", () => {
  const lines = ["· 3rd", "Attended UBS", "TCS · UBS", "Mumbai, Maharashtra, India", "·", "Contact info", "TCS", "UBS", "171", "connections"];
  assert.deepEqual(parseTopcardLines(lines), { headline: "Attended UBS", location: "Mumbai, Maharashtra, India" });
});

// Taken from a live profile on 2026-11-01: the old first-line-with-a-comma rule read this headline as the location.
test("a headline with a comma in it is not mistaken for the location", () => {
  const headline = "Corporate Health & Weight Loss Coach | Helping Busy Professionals Lose 10–20kg, Reverse Belly Fat, Diabetes & Fatty Liver";
  const lines = ["· 3rd", headline, "Freelance · Guru Nanak Dev University, Amritsar", "Bengaluru, Karnataka, India", "·", "Contact info", "Freelance", "Guru Nanak Dev University, Amritsar", "500+", "connections"];
  assert.deepEqual(parseTopcardLines(lines), { headline, location: "Bengaluru, Karnataka, India" });
});

test("pronouns above the degree badge are skipped", () => {
  const lines = ["He/Him", "· 3rd", "Technical Project Manager @ Cognizant | React.js specialist", "Cognizant · Amravati University", "Pune City, Maharashtra, India", "·", "Contact info"];
  assert.deepEqual(parseTopcardLines(lines), { headline: "Technical Project Manager @ Cognizant | React.js specialist", location: "Pune City, Maharashtra, India" });
});

// LinkedIn renders a 1st and a 2nd badge and hides one with CSS, and the browser reports both lines.
test("a second degree badge is not taken for the headline", () => {
  const lines = ["· 1st", "· 2nd", "Founder at Acme", "Pune, Maharashtra, India", "·", "Contact info"];
  assert.deepEqual(parseTopcardLines(lines), { headline: "Founder at Acme", location: "Pune, Maharashtra, India" });
});

// The location is found by its place next to "Contact info"; without that anchor a guess could put a headline in the location field, so it stays empty.
test("without a Contact info line the location is null rather than a guess", () => {
  assert.deepEqual(parseTopcardLines(["· 2nd", "Founder at Acme, Pune"]), { headline: "Founder at Acme, Pune", location: null });
});

test("an empty top card gives null headline and location", () => {
  assert.deepEqual(parseTopcardLines([]), { headline: null, location: null });
});

// With no headline the line before the location is the location itself, and reporting it twice would make an AI step think the person describes themselves by a city.
test("a profile with no headline gives a null headline, not the location", () => {
  assert.deepEqual(parseTopcardLines(["· 2nd", "Bengaluru, Karnataka, India", "·", "Contact info"]), { headline: null, location: "Bengaluru, Karnataka, India" });
});

// A card with no degree badge (the account's own profile) still starts with pronouns when the person set them.
test("pronouns are skipped when there is no degree badge", () => {
  assert.deepEqual(parseTopcardLines(["She/Her", "Building HireDue", "Bengaluru, Karnataka, India", "·", "Contact info"]), { headline: "Building HireDue", location: "Bengaluru, Karnataka, India" });
});
