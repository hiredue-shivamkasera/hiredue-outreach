// Fetches JSON from the URL a Poll API trigger names. Throws with the HTTP status on anything but a JSON 2xx, so a broken API never reads as "no new records".

const { TRIGGERS } = require("../constants.cjs");

async function fetchJson(url, { headers = {}, fetch = globalThis.fetch } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("The API URL must start with http:// or https://");
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TRIGGERS.API_TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) throw new Error(`The API answered HTTP ${res.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { throw new Error(`The API did not answer with JSON: ${body.slice(0, 120)}`); }
}

module.exports = { fetchJson };
