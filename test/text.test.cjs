const test = require("node:test");
const assert = require("node:assert/strict");
const { render, matchesAny, firstName } = require("../electron/domain/text.cjs");

test("render fills known fields and blanks unknown ones", () => {
  assert.equal(render("Hi {{firstName}}, saw your note on {{ topic }}.", { firstName: "Asha" }), "Hi Asha, saw your note on .");
});

test("render reads nested fields with dots", () => {
  assert.equal(render("{{evaluation.reason}}", { evaluation: { reason: "runs a B2B agency" } }), "runs a B2B agency");
});

test("render leaves text without placeholders alone", () => {
  assert.equal(render("Hello there", {}), "Hello there");
});

test("firstName takes the first word and drops honorifics and emoji", () => {
  assert.equal(firstName("Dr. Asha Rao"), "Asha");
  assert.equal(firstName("🚀 Ravi Kumar"), "Ravi");
  assert.equal(firstName("MEERA"), "Meera");
  assert.equal(firstName(""), "");
});

test("matchesAny is case-insensitive and ignores surrounding punctuation", () => {
  assert.equal(matchesAny("Interested!! 🙋", "interested"), true);
  assert.equal(matchesAny("I'm keen, please share", "interested, keen"), true);
  assert.equal(matchesAny("Congrats on the role", "interested"), false);
});

// "interested" must not match "uninterested", or the people who said no get messaged.
test("matchesAny matches whole words only", () => {
  assert.equal(matchesAny("honestly uninterested", "interested"), false);
});

test("an empty word list matches every comment", () => {
  assert.equal(matchesAny("anything", ""), true);
  assert.equal(matchesAny("anything", " , "), true);
});

test("a multi-word phrase matches as a phrase", () => {
  assert.equal(matchesAny("Please DM me the details", "dm me"), true);
  assert.equal(matchesAny("me, DM later", "dm me"), false);
});

const { renderOutgoing } = require("../electron/domain/text.cjs");

// Text that reaches another person must never go out as "Hi , quick question." because a field was missing.
test("renderOutgoing refuses when a placeholder has no value, naming it", () => {
  assert.throws(() => renderOutgoing("Hi {{firstName}}, about {{ draft }}", { draft: "x" }), /\{\{firstName\}\}/);
  assert.throws(() => renderOutgoing("Hi {{firstName}}", { firstName: "  " }), /firstName/);
});

test("renderOutgoing fills and trims when every placeholder has a value", () => {
  assert.equal(renderOutgoing("  Hi {{firstName}}, score {{ai.score}} ", { firstName: "Asha", ai: { score: 0 } }), "Hi Asha, score 0");
});

test("renderOutgoing passes text with no placeholders through", () => {
  assert.equal(renderOutgoing("Hello there", {}), "Hello there");
});
