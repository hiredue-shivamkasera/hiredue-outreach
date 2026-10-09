// What a Poll API trigger takes from an API answer: the list at a path, the records not seen before, and the LinkedIn items they point at. Pure.

const { itemFromUrl } = require("./linkedinData.cjs");

const get = (obj, path) => (path ? String(path).split(".").reduce((v, k) => (v == null ? v : v[k]), obj) : obj);

function recordsAt(json, path) {
  const list = get(json, path);
  return Array.isArray(list) ? list : null;
}

function newRecords(records, seen, keyField) {
  const fresh = [];
  const keys = [];
  const batch = new Set();
  for (const r of records) {
    const raw = keyField ? get(r, keyField) : JSON.stringify(r);
    if (raw === undefined || raw === null || raw === "") continue;
    const key = String(raw);
    if (seen.has(key) || batch.has(key)) continue;
    batch.add(key);
    fresh.push(r);
    keys.push(key);
  }
  return { fresh, keys };
}

// The record's own fields ride along, so a template can use {{note}} or any other column the API sends.
function toItems(records, urlField, kind) {
  const items = [];
  let rejected = 0;
  for (const r of records) {
    const item = itemFromUrl(get(r, urlField));
    if (!item || item.kind !== kind) { rejected++; continue; }
    items.push({ ...(typeof r === "object" ? r : {}), ...item });
  }
  return { items, rejected };
}

module.exports = { recordsAt, newRecords, toItems };
