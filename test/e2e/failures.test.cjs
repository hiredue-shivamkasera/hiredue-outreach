// What a run does when LinkedIn misbehaves: a lost session, the weekly invite limit, actions LinkedIn never confirms, items that fail, and the person pressing Stop. Each scenario is its own app launch because the fake LinkedIn's behaviour is fixed per process.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, chain, steps, profile } = require("./harness.cjs");

const start = { id: "start", type: "start" };
const urls = (...slugs) => ({ id: "urls", type: "urlList", params: { urls: slugs.map(profile).join("\n"), itemKind: "person" } });
const connect = (params = {}) => ({ id: "connect", type: "connect", params: { note: "", perDay: 20, perWeek: 100, ...params } });

describe("logged out", () => {
  let app;
  before(async () => { app = await launch({ scenario: "logged-out" }); });
  after(() => app?.close());

  test("A lost LinkedIn session fails the run before any step does anything", async () => {
    const a = await app.createAccount("logged out");
    const run = await app.run(chain("logged out", a.id, [start, urls("lo-one"), { id: "visit", type: "visitProfile" }, connect()]));
    assert.equal(run.status, "failed");
    assert.match(run.error, /not logged in/i);
    assert.deepEqual(app.actions({ accountId: a.id }).map((x) => x.action), ["session.open"]);
    assert.equal(run.actions.length, 0);
    assert.ok(run.summary.steps.every((s) => s.state === null || s.state === undefined), "no step started");
  });
});

describe("invite limit", () => {
  let app;
  before(async () => { app = await launch({ scenario: "invite-limit" }); });
  after(() => app?.close());

  test("LinkedIn's weekly invite limit stops the Connect step but the run still finishes", async () => {
    const a = await app.createAccount("invite limit");
    const run = await app.run(chain("invite limit", a.id, [start, urls("il-one", "il-two", "il-three", "il-four"), connect()]));
    assert.equal(run.status, "finished", run.error);
    // The fake refuses after two invites; the fourth person is never tried.
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => [x.target, x.status]), [[profile("il-one"), "sent"], [profile("il-two"), "sent"], [profile("il-three"), "limit"]]);
    assert.deepEqual(run.actions.map((x) => x.status), ["sent", "sent", "limit"]);
    assert.equal(steps(run).connect.counts.out, 2);
  });
});

describe("unverified", () => {
  let app;
  before(async () => { app = await launch({ scenario: "unverified" }); });
  after(() => app?.close());

  test("An invite LinkedIn never confirms is recorded unverified, not passed on, and not counted against the cap", async () => {
    const a = await app.createAccount("unverified");
    const run = await app.run(chain("unverified", a.id, [start, urls("uv-one", "uv-two"), connect({ perDay: 1 }), { id: "follow", type: "follow", params: { perDay: 30 } }]));
    assert.equal(run.status, "finished", run.error);
    // With a cap of one, a counted unverified invite would have stopped the second attempt.
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => x.status), ["unverified", "unverified"]);
    assert.deepEqual(run.actions.map((x) => x.status), ["unverified", "unverified"]);
    assert.equal(steps(run).connect.counts.out, 0);
    assert.equal(steps(run).follow.state, "skipped");
  });

  test("An unverified action is tried again by a later run because it was never proven done", async () => {
    const a = await app.createAccount("unverified retry");
    const wf = await app.save(chain("unverified retry", a.id, [start, urls("uv-again"), connect()]));
    await app.waitForRun(await app.start(wf.id));
    await app.waitForRun(await app.start(wf.id));
    assert.equal(app.actions({ accountId: a.id, action: "connect" }).length, 2);
  });

  // A comment LinkedIn did not confirm may already be on the post; a second one would show twice in public.
  test("An unverified comment is never tried again, unlike an invite", async () => {
    const a = await app.createAccount("unverified comment");
    const post = { id: "posts", type: "urlList", params: { urls: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000003/", itemKind: "post" } };
    const wf = await app.save(chain("unverified comment", a.id, [start, post, { id: "comment", type: "comment", params: { text: "Good point", perDay: 15 } }]));
    await app.waitForRun(await app.start(wf.id));
    await app.waitForRun(await app.start(wf.id));
    assert.deepEqual(app.actions({ accountId: a.id, action: "comment" }).map((x) => x.status), ["unverified"]);
  });
});

describe("flaky", () => {
  let app;
  before(async () => { app = await launch({ scenario: "flaky" }); });
  after(() => app?.close());

  test("One profile that fails to load costs only that person and the run finishes", async () => {
    const a = await app.createAccount("flaky");
    const run = await app.run(chain("flaky", a.id, [start, urls("ana-seeker", "cara-student", "ben-builder"), { id: "visit", type: "visitProfile" }, connect()]));
    assert.equal(run.status, "finished", run.error);
    assert.equal(steps(run).visit.failedItems, 1);
    assert.equal(steps(run).visit.counts.out, 2);
    assert.ok(run.events.some((e) => e.type === "item.failed" && /did not load/.test(e.message)));
    assert.deepEqual(app.actions({ accountId: a.id, action: "connect" }).map((x) => x.target), [profile("ana-seeker"), profile("ben-builder")]);
  });

  test("Three failures on the first three items fail the run, because the step itself is broken", async () => {
    const a = await app.createAccount("flaky start");
    const run = await app.run(chain("flaky start", a.id, [start, urls("cara-a", "cara-b", "cara-c", "ana-seeker"), { id: "visit", type: "visitProfile" }, connect()]));
    assert.equal(run.status, "failed");
    assert.match(run.error, /first three items all failed/);
    assert.equal(app.actions({ accountId: a.id, action: "connect" }).length, 0);
  });

  test("A post whose Like button is missing is recorded failed and the other posts are still liked", async () => {
    const a = await app.createAccount("flaky like");
    const posts = { id: "urls", type: "urlList", params: { urls: [3, 4].map((n) => `https://www.linkedin.com/feed/update/urn:li:activity:700000000000000000${n}/`).join("\n"), itemKind: "post" } };
    const run = await app.run(chain("flaky like", a.id, [start, posts, { id: "like", type: "like", params: { reaction: "like", perDay: 50 } }]));
    assert.equal(run.status, "finished", run.error);
    assert.deepEqual(run.actions.map((x) => x.status), ["sent", "failed"]);
    assert.equal(steps(run).like.counts.out, 1);
  });

  test("An AI answer the app cannot read is an item error, never a no", async () => {
    const a = await app.createAccount("unreadable");
    const run = await app.run(chain("unreadable", a.id, [start, urls("ana-seeker", "unreadable-lead", "ben-builder"), { id: "visit", type: "visitProfile" }, { id: "qualify", type: "qualify", params: { prompt: 'Qualifies if the lead mentions "founder".', minScore: 70 } }]));
    assert.equal(run.status, "finished", run.error);
    assert.deepEqual(steps(run).qualify.counts, { pass: 1, fail: 1 });
    assert.equal(steps(run).qualify.failedItems, 1);
  });
});

describe("stop", () => {
  let app;
  before(async () => { app = await launch({ scenario: "slow" }); });
  after(() => app?.close());

  async function stopDuring(app, wf, nodeId) {
    const saved = await app.save(wf);
    const runId = await app.start(saved.id);
    await app.waitFor(async () => (await app.getRun(runId)).events.some((e) => e.type === "node.started" && e.nodeId === nodeId), { what: `${nodeId} to start` });
    assert.equal(await app.call("runs.stop", runId), true);
    return app.waitForRun(runId);
  }

  test("Stop pressed mid-run ends the run as stopped and later steps never act", async () => {
    const a = await app.createAccount("stop");
    const run = await stopDuring(app, chain("stop", a.id, [start, urls("st-1", "st-2", "st-3", "st-4", "st-5", "st-6"), { id: "visit", type: "visitProfile" }, connect()]), "visit");
    assert.equal(run.status, "stopped");
    assert.ok((run.outputs.visit?.out.length ?? 0) < 6);
    assert.equal(app.actions({ accountId: a.id, action: "connect" }).length, 0);
  });

  // The engine checks Stop only between steps, so a stop during the last step falls out of the loop as finished.
  test("Stop pressed during the last step still ends the run as stopped", async () => {
    const a = await app.createAccount("stop last");
    const run = await stopDuring(app, chain("stop last", a.id, [start, urls("sl-1", "sl-2", "sl-3", "sl-4", "sl-5", "sl-6"), connect()]), "connect");
    assert.ok(app.actions({ accountId: a.id, action: "connect" }).length < 6);
    assert.equal(run.status, "stopped");
  });

  test("Stopping a run that already ended reports that nothing was running", async () => {
    const a = await app.createAccount("stop late");
    const run = await app.run(chain("stop late", a.id, [start, urls("late-1")]));
    assert.equal(await app.call("runs.stop", run.id), false);
  });
});
