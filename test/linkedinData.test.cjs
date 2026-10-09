const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePostStream, mergePosts, parsePersonCard, cleanProfileUrl, postedAt } = require("../electron/domain/linkedinData.cjs");

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
