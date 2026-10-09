// Asks a language model for a JSON answer over any OpenAI-compatible chat endpoint (the HireDue LiteLLM proxy by default). Returns { ok, value } or { ok: false, error }, never a made-up default.

const { TIMEOUT } = require("../constants.cjs");

// Models wrap JSON in fences or prose despite being told not to, so find the first balanced object and ignore the rest.
function extractJson(text) {
  const s = String(text || "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { const v = JSON.parse(s.slice(start, i + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* try the next opening brace */ }
        break;
      }
    }
  }
  return null;
}

function createLlm(getSettings, { fetch = globalThis.fetch } = {}) {
  async function post(settings, body) {
    const res = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT.LLM),
    });
    return res;
  }

  async function chatJson({ system, user }) {
    const settings = getSettings();
    if (!settings.apiKey) return { ok: false, error: "No LLM API key set; add one in Settings" };
    const body = { model: settings.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" } };
    try {
      let res = await post(settings, body);
      if (res.status === 400) { delete body.response_format; res = await post(settings, body); }
      if (!res.ok) return { ok: false, error: `LLM endpoint answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const content = (await res.json())?.choices?.[0]?.message?.content;
      const value = extractJson(content);
      return value ? { ok: true, value } : { ok: false, error: `LLM did not return a JSON object: ${String(content).slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: `LLM call failed: ${err.message}` };
    }
  }

  return { chatJson };
}

module.exports = { createLlm, extractJson };
