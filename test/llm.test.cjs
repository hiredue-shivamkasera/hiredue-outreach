const test = require("node:test");
const assert = require("node:assert/strict");
const { extractJson, createLlm } = require("../electron/adapters/llm.adapter.cjs");

test("extractJson reads a bare object", () => {
  assert.deepEqual(extractJson('{"qualified": true, "score": 80}'), { qualified: true, score: 80 });
});

test("extractJson reads an object inside a markdown fence and surrounding chatter", () => {
  assert.deepEqual(extractJson('Sure.\n```json\n{"qualified": false}\n```\nDone'), { qualified: false });
});

test("extractJson finds the first balanced object even with braces in strings", () => {
  assert.deepEqual(extractJson('Here: {"reason": "uses {curly} words", "ok": 1} trailing }'), { reason: "uses {curly} words", ok: 1 });
});

// A non-answer must come back as null so a step never treats "could not judge" as "not qualified".
test("extractJson returns null for text with no object", () => {
  assert.equal(extractJson("I cannot help with that"), null);
  assert.equal(extractJson("[1,2]"), null);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift();
    return { ok: r.status === 200, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

const settings = () => ({ baseUrl: "https://llm.test/v1/", model: "m1", apiKey: "k" });

test("chatJson posts to chat/completions and returns the parsed answer", async () => {
  const fetch = fakeFetch([{ status: 200, body: { choices: [{ message: { content: '{"qualified":true}' } }] } }]);
  const llm = createLlm(settings, { fetch });
  assert.deepEqual(await llm.chatJson({ system: "s", user: "u" }), { ok: true, value: { qualified: true } });
  assert.equal(fetch.calls[0].url, "https://llm.test/v1/chat/completions");
  assert.equal(fetch.calls[0].body.model, "m1");
});

// Some OpenAI-compatible servers reject response_format; the call should still work without it.
test("chatJson retries without response_format when the server rejects it", async () => {
  const fetch = fakeFetch([{ status: 400, body: { error: "response_format not supported" } }, { status: 200, body: { choices: [{ message: { content: '{"a":1}' } }] } }]);
  const llm = createLlm(settings, { fetch });
  assert.deepEqual(await llm.chatJson({ system: "s", user: "u" }), { ok: true, value: { a: 1 } });
  assert.equal(fetch.calls[1].body.response_format, undefined);
});

test("chatJson reports a failure instead of an empty answer", async () => {
  const fetch = fakeFetch([{ status: 500, body: { error: "boom" } }]);
  const result = await createLlm(settings, { fetch }).chatJson({ system: "s", user: "u" });
  assert.equal(result.ok, false);
  assert.match(result.error, /500/);
});

test("chatJson refuses to run without an API key", async () => {
  const result = await createLlm(() => ({ ...settings(), apiKey: "" }), { fetch: fakeFetch([]) }).chatJson({ system: "s", user: "u" });
  assert.equal(result.ok, false);
  assert.match(result.error, /API key/);
});
