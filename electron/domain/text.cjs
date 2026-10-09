// Text rules shared by the steps: filling message templates and matching comment words. Pure.

function render(template, data) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const value = path.split(".").reduce((v, k) => (v == null ? v : v[k]), data);
    return value == null ? "" : String(value);
  });
}

// For text another person will read: a missing or blank value is an error naming the placeholder, never an empty gap in the message.
function renderOutgoing(template, data) {
  const missing = [];
  const text = String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const value = path.split(".").reduce((v, k) => (v == null ? v : v[k]), data);
    if (value == null || String(value).trim() === "") { missing.push(path); return ""; }
    return String(value);
  });
  if (missing.length) throw new Error(`the text uses ${missing.map((m) => `{{${m}}}`).join(", ")}, which this item has no value for`);
  return text.trim();
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "prof", "er", "ca", "adv"]);

function firstName(fullName) {
  const words = String(fullName || "").split(/\s+/).map((w) => w.replace(/[^\p{L}'-]/gu, "")).filter(Boolean);
  const word = words.find((w) => !HONORIFICS.has(w.toLowerCase())) || "";
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : "";
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Unicode-aware word edges so "interested" never matches inside "uninterested".
function matchesAny(text, wordList) {
  const words = String(wordList || "").split(",").map((w) => w.trim()).filter(Boolean);
  if (!words.length) return true;
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(String(text || "")));
}

module.exports = { render, renderOutgoing, firstName, matchesAny };
