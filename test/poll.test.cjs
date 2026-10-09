const test = require("node:test");
const assert = require("node:assert/strict");
const { recordsAt, newRecords, toItems } = require("../electron/domain/poll.cjs");

test("recordsAt follows a dotted path to the list", () => {
  assert.deepEqual(recordsAt({ data: { leads: [{ a: 1 }] } }, "data.leads"), [{ a: 1 }]);
  assert.deepEqual(recordsAt([{ a: 1 }], ""), [{ a: 1 }]);
});

// A path that misses is a configuration error to report, not "no new leads".
test("recordsAt returns null when the path does not lead to a list", () => {
  assert.equal(recordsAt({ data: {} }, "data.leads"), null);
  assert.equal(recordsAt({ data: { leads: { a: 1 } } }, "data.leads"), null);
});

test("newRecords drops what was seen before and repeats within the batch", () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 2 }, { id: 3 }];
  const { fresh, keys } = newRecords(records, new Set(["1"]), "id");
  assert.deepEqual(fresh.map((r) => r.id), [2, 3]);
  assert.deepEqual(keys, ["2", "3"]);
});

test("without a key field the whole record is the key", () => {
  const { fresh } = newRecords([{ u: "a" }, { u: "a" }, { u: "b" }], new Set(), "");
  assert.equal(fresh.length, 2);
});

test("records without the key field are skipped rather than treated as new forever", () => {
  const { fresh } = newRecords([{ id: 1 }, { name: "x" }], new Set(), "id");
  assert.deepEqual(fresh, [{ id: 1 }]);
});

test("toItems turns records into items of the chosen kind and keeps the other fields", () => {
  const { items, rejected } = toItems([{ url: "https://www.linkedin.com/in/asha-rao?x=1", note: "hot lead" }, { url: "https://www.linkedin.com/company/acme/" }], "url", "person");
  assert.deepEqual(items, [{ kind: "person", profileUrl: "https://www.linkedin.com/in/asha-rao/", note: "hot lead", url: "https://www.linkedin.com/in/asha-rao?x=1" }]);
  assert.equal(rejected, 1);
});
