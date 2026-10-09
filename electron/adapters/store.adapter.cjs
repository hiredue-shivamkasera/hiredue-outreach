// The SQLite file holding accounts, workflows, runs, trigger state, the action ledger, the CRM and follow-up sequences. The ledger is what daily caps count and what stops any person or post being acted on twice, across every workflow on an account.

const Database = require("better-sqlite3");
const crypto = require("crypto");
const { summarize } = require("../domain/runSummary.cjs");
const { STATES: OUTREACH_STATES, stateLabel, isTerminal, sentState } = require("../domain/outreach.cjs");
const { STAGES, isStage, advanceStage, stageFromSignals, mergeSnapshot, peopleAndPostsIn, engagementOf, ENGAGEMENT_ACTIONS, parseTags } = require("../domain/crm.cjs");
const { dueAt } = require("../domain/followup.cjs");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_url TEXT, last_login_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT, graph TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, node_id TEXT, message TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS run_outputs (run_id TEXT NOT NULL, node_id TEXT NOT NULL, handle TEXT NOT NULL, items TEXT NOT NULL, PRIMARY KEY (run_id, node_id, handle));
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, run_id TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS actions_by_time ON actions (account_id, action, at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS trigger_state (workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, next_at INTEGER, last_at INTEGER, last_error TEXT, last_result TEXT, seen TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (workflow_id, node_id));
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, profile_url TEXT NOT NULL, name TEXT, headline TEXT, location TEXT, degree TEXT, stage TEXT NOT NULL DEFAULT 'new', tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', replied INTEGER NOT NULL DEFAULT 0, source_workflow_id TEXT, source_run_id TEXT, data TEXT NOT NULL DEFAULT '{}', first_seen_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, UNIQUE (account_id, profile_url));
CREATE INDEX IF NOT EXISTS contacts_by_activity ON contacts (last_activity_at);
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, post_key TEXT NOT NULL, post_url TEXT, author_name TEXT, author_url TEXT, text TEXT, source_workflow_id TEXT, source_run_id TEXT, data TEXT NOT NULL DEFAULT '{}', first_seen_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, UNIQUE (account_id, post_key));
CREATE INDEX IF NOT EXISTS posts_by_activity ON posts (last_activity_at);
CREATE TABLE IF NOT EXISTS crm_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, run_id TEXT);
CREATE INDEX IF NOT EXISTS crm_events_by_entity ON crm_events (entity, entity_id);
CREATE TABLE IF NOT EXISTS followups (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, profile_url TEXT NOT NULL, name TEXT, workflow_id TEXT, node_id TEXT, steps TEXT NOT NULL, stop_on_reply INTEGER NOT NULL DEFAULT 1, per_day INTEGER, step_index INTEGER NOT NULL DEFAULT 0, next_due_at INTEGER, status TEXT NOT NULL, last_sent_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS followups_by_due ON followups (status, next_due_at);
`;

// An API that keeps returning old records would otherwise grow the seen list forever; the newest keys are the ones that matter.
const SEEN_KEYS_KEPT = 5000;

// Columns added after the first version; SQLite has no ADD COLUMN IF NOT EXISTS.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  // Where each person is in an Outreach sequence; JSON because the step owns its shape (domain/outreach.cjs).
  if (!has("contacts", "outreach")) db.exec("ALTER TABLE contacts ADD COLUMN outreach TEXT");
  // Built-in workflows are seeded once per key, so an install gets new ones without duplicating ones it already has or bringing back ones the owner deleted.
  if (!has("workflows", "template_key")) db.exec("ALTER TABLE workflows ADD COLUMN template_key TEXT");
  if (has("actions", "profile_url")) db.exec("ALTER TABLE actions RENAME COLUMN profile_url TO target");
  db.exec("DROP INDEX IF EXISTS actions_by_person; CREATE INDEX IF NOT EXISTS actions_by_target ON actions (account_id, target, action)");
  if (!has("workflows", "active")) db.exec("ALTER TABLE workflows ADD COLUMN active INTEGER NOT NULL DEFAULT 0");
  if (!has("runs", "fired_by")) db.exec("ALTER TABLE runs ADD COLUMN fired_by TEXT");
  // The workflow as it was when the run started, so history still shows what ran after the workflow is edited.
  if (!has("runs", "graph")) db.exec("ALTER TABLE runs ADD COLUMN graph TEXT");
  if (!has("runs", "summary")) db.exec("ALTER TABLE runs ADD COLUMN summary TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS runs_by_time ON runs (started_at); CREATE INDEX IF NOT EXISTS actions_by_run ON actions (run_id); CREATE INDEX IF NOT EXISTS events_by_run ON run_events (run_id)");
  // The database itself refuses a second active sequence for the same person on the same account, so two runs enrolling at once cannot both win.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS followups_one_active ON followups (account_id, profile_url) WHERE status = 'active'");
}

// Statuses that mean the thing is done on LinkedIn, by this run or before it; a target in one of these is never acted on again.
const DONE = ["sent", "pending", "connected", "already_messaged", "already"];

function openStore(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  const id = () => crypto.randomUUID();
  const now = () => Date.now();
  const json = (v) => (v == null ? null : JSON.parse(v));

  const accounts = {
    list: () => db.prepare("SELECT id, name, profile_url AS profileUrl, last_login_at AS lastLoginAt FROM accounts ORDER BY created_at").all(),
    get: (accountId) => db.prepare("SELECT id, name, profile_url AS profileUrl, last_login_at AS lastLoginAt FROM accounts WHERE id = ?").get(accountId) || null,
    create: (name) => { const a = { id: id(), name }; db.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)").run(a.id, name, now()); return a; },
    markLoggedIn: (accountId, profileUrl) => db.prepare("UPDATE accounts SET profile_url = COALESCE(?, profile_url), last_login_at = ? WHERE id = ?").run(profileUrl, now(), accountId),
    // The browser profile is keyed by the account id, not the name, so a rename keeps the LinkedIn login.
    rename: (accountId, name) => {
      const clean = String(name ?? "").trim();
      if (!clean) throw new Error("An account needs a name");
      if (!db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(clean, accountId).changes) throw new Error("Account not found");
      return accounts.get(accountId);
    },
    // A sequence on a deleted account could never send, so it is cancelled rather than left due forever.
    remove: (accountId) => {
      db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      db.prepare("UPDATE followups SET status = 'cancelled', next_due_at = NULL, updated_at = ? WHERE account_id = ? AND status = 'active'").run(now(), accountId);
    },
  };

  const workflows = {
    list: () => db.prepare("SELECT id, name, account_id AS accountId, active, template_key AS templateKey, updated_at AS updatedAt FROM workflows ORDER BY updated_at DESC").all().map((w) => ({ ...w, active: !!w.active })),
    hasTemplate: (key) => !!db.prepare("SELECT 1 FROM workflows WHERE template_key = ?").get(key),
    listActive: () => db.prepare("SELECT id FROM workflows WHERE active = 1").all().map((r) => r.id),
    get: (workflowId) => {
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId);
      return row ? { id: row.id, name: row.name, accountId: row.account_id, active: !!row.active, templateKey: row.template_key || null, ...json(row.graph) } : null;
    },
    setActive: (workflowId, active) => db.prepare("UPDATE workflows SET active = ? WHERE id = ?").run(active ? 1 : 0, workflowId),
    save: (wf) => {
      const wfId = wf.id || id();
      db.prepare("INSERT INTO workflows (id, name, account_id, graph, updated_at, template_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, graph = excluded.graph, updated_at = excluded.updated_at")
        .run(wfId, wf.name, wf.accountId || null, JSON.stringify({ nodes: wf.nodes, edges: wf.edges }), now(), wf.templateKey || null);
      return workflows.get(wfId);
    },
    remove: (workflowId) => { db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId); db.prepare("DELETE FROM trigger_state WHERE workflow_id = ?").run(workflowId); },
  };

  const triggers = {
    get: (workflowId, nodeId) => {
      const row = db.prepare("SELECT * FROM trigger_state WHERE workflow_id = ? AND node_id = ?").get(workflowId, nodeId);
      return { nextAt: row?.next_at ?? null, lastAt: row?.last_at ?? null, lastError: row?.last_error ?? null, lastResult: row?.last_result ?? null, seen: json(row?.seen) || [] };
    },
    forWorkflow: (workflowId) => db.prepare("SELECT node_id AS nodeId, next_at AS nextAt, last_at AS lastAt, last_error AS lastError, last_result AS lastResult FROM trigger_state WHERE workflow_id = ?").all(workflowId),
    set: (workflowId, nodeId, patch) => {
      const cur = triggers.get(workflowId, nodeId);
      const next = { ...cur, ...patch };
      db.prepare("INSERT INTO trigger_state (workflow_id, node_id, next_at, last_at, last_error, last_result, seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_id, node_id) DO UPDATE SET next_at = excluded.next_at, last_at = excluded.last_at, last_error = excluded.last_error, last_result = excluded.last_result")
        .run(workflowId, nodeId, next.nextAt, next.lastAt, next.lastError, next.lastResult, JSON.stringify(cur.seen));
    },
    markSeen: (workflowId, nodeId, keys) => {
      if (!keys.length) return;
      const seen = [...triggers.get(workflowId, nodeId).seen, ...keys].slice(-SEEN_KEYS_KEPT);
      triggers.set(workflowId, nodeId, {});
      db.prepare("UPDATE trigger_state SET seen = ? WHERE workflow_id = ? AND node_id = ?").run(JSON.stringify(seen), workflowId, nodeId);
    },
    // Settings may have changed, so every trigger in the workflow recomputes its next fire time on the next tick.
    reset: (workflowId) => db.prepare("UPDATE trigger_state SET next_at = NULL WHERE workflow_id = ?").run(workflowId),
  };

  const eventsOf = (runId) => db.prepare("SELECT data FROM run_events WHERE run_id = ? ORDER BY id").all(runId).map((r) => json(r.data));
  // Runs from before summaries were stored, or still going, are summarised from their events on read.
  const summaryOf = (row) => {
    const nodes = json(row.graph)?.nodes || [];
    const summary = json(row.summary) || summarize(eventsOf(row.id), nodes);
    const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
    return { ...summary, steps: summary.steps.map((s) => ({ ...s, type: s.type ?? typeOf.get(s.nodeId) ?? null })) };
  };
  const actionCounts = (runId) => {
    const out = {};
    for (const r of db.prepare("SELECT action, status, COUNT(*) AS n FROM actions WHERE run_id = ? GROUP BY action, status").all(runId)) (out[r.action] ||= {})[r.status] = r.n;
    return out;
  };
  // Runs from before snapshots were stored fall back to the workflow as it is now, which is the best record left of what they ran.
  const RUN_COLUMNS = "r.id, r.workflow_id AS workflowId, w.name AS workflowName, r.account_id AS accountId, a.name AS accountName, r.status, r.error, r.fired_by AS firedBy, r.started_at AS startedAt, r.finished_at AS finishedAt, COALESCE(r.graph, w.graph) AS graph, r.graph IS NULL AS graphIsCurrent, r.summary";
  const RUN_FROM = "FROM runs r LEFT JOIN workflows w ON w.id = r.workflow_id LEFT JOIN accounts a ON a.id = r.account_id";

  const runs = {
    start: (workflowId, accountId, firedBy, graph) => { const r = id(); db.prepare("INSERT INTO runs (id, workflow_id, account_id, status, started_at, fired_by, graph) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(r, workflowId, accountId, now(), firedBy || "manual", graph ? JSON.stringify(graph) : null); return r; },
    finish: (runId, status, error) => {
      const row = db.prepare("SELECT r.id, COALESCE(r.graph, w.graph) AS graph, NULL AS summary FROM runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?").get(runId);
      db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ?, summary = ? WHERE id = ?").run(status, error || null, now(), JSON.stringify(summaryOf(row)), runId);
    },
    // A crash or a force-quit leaves runs marked running forever; on startup they are closed as interrupted.
    closeInterrupted: () => db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now()),
    event: (runId, e) => db.prepare("INSERT INTO run_events (run_id, at, type, node_id, message, data) VALUES (?, ?, ?, ?, ?, ?)").run(runId, e.at || now(), e.type, e.nodeId || null, e.message || null, JSON.stringify(e)),
    saveOutputs: db.transaction((runId, outputs) => {
      const put = db.prepare("INSERT OR REPLACE INTO run_outputs (run_id, node_id, handle, items) VALUES (?, ?, ?, ?)");
      for (const [nodeId, byHandle] of Object.entries(outputs)) for (const [handle, items] of Object.entries(byHandle)) put.run(runId, nodeId, handle, JSON.stringify(items));
    }),
    list: (workflowId) => db.prepare("SELECT id, workflow_id AS workflowId, account_id AS accountId, status, error, fired_by AS firedBy, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 50").all(workflowId),
    // The history page: newest first, filterable, paged by start time so new runs arriving do not shift the pages.
    history: ({ workflowId = null, status = null, before = null, limit = 50 } = {}) => {
      const where = [];
      const args = [];
      if (workflowId) { where.push("r.workflow_id = ?"); args.push(workflowId); }
      if (status) { where.push("r.status = ?"); args.push(status); }
      if (before) { where.push("r.started_at < ?"); args.push(before); }
      const rows = db.prepare(`SELECT ${RUN_COLUMNS} ${RUN_FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.started_at DESC LIMIT ?`).all(...args, limit);
      return rows.map(({ graph, summary, graphIsCurrent, ...row }) => ({ ...row, summary: summaryOf({ id: row.id, graph, summary }), steps: (json(graph)?.nodes || []).map((n) => ({ id: n.id, type: n.type })), actions: actionCounts(row.id) }));
    },
    get: (runId) => {
      const row = db.prepare(`SELECT ${RUN_COLUMNS} ${RUN_FROM} WHERE r.id = ?`).get(runId);
      if (!row) return null;
      const { graph, summary, ...run } = row;
      run.graph = json(graph);
      run.graphIsCurrent = !!run.graphIsCurrent;
      run.events = eventsOf(runId);
      run.summary = summaryOf({ id: runId, graph, summary });
      run.outputs = {};
      for (const o of db.prepare("SELECT node_id, handle, items FROM run_outputs WHERE run_id = ?").all(runId)) (run.outputs[o.node_id] ||= {})[o.handle] = json(o.items);
      run.actions = db.prepare("SELECT target, action, status, detail, at FROM actions WHERE run_id = ? ORDER BY id").all(runId);
      return run;
    },
    remove: (runId) => {
      for (const t of ["run_events", "run_outputs"]) db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(runId);
      db.prepare("DELETE FROM runs WHERE id = ? AND status != 'running'").run(runId);
    },
  };

  const actions = {
    record: ({ accountId, target, action, status, detail, runId }) => db.prepare("INSERT INTO actions (account_id, target, action, status, detail, run_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(accountId, target, action, status, detail || null, runId || null, now()),
    // Only invites and messages LinkedIn accepted count toward a cap; a failed attempt costs nothing on LinkedIn's side.
    countSince: (accountId, action, sinceMs) => db.prepare("SELECT COUNT(*) AS n FROM actions WHERE account_id = ? AND action = ? AND status = 'sent' AND at >= ?").get(accountId, action, sinceMs).n,
    // A comment or repost LinkedIn did not confirm may still have posted, and posting it again shows twice on the post; invites and messages have their own guards (Pending, an existing thread) so their unverified attempts may be retried.
    alreadyDone: (accountId, target, action) => !!db.prepare(`SELECT 1 FROM actions WHERE account_id = ? AND target = ? AND action = ? AND (status IN (${DONE.map(() => "?").join(",")}) OR (action IN ('comment', 'repost') AND status = 'unverified')) LIMIT 1`).get(accountId, target, action, ...DONE),
    recent: (accountId, limit = 200) => db.prepare("SELECT target, action, status, detail, at FROM actions WHERE account_id = ? ORDER BY at DESC LIMIT ?").all(accountId, limit),
    // When this account last got a message through to the person, by the Message step or a follow-up; null when it never did.
    lastSentAt: (accountId, target) => db.prepare("SELECT MAX(at) AS at FROM actions WHERE account_id = ? AND target = ? AND action IN ('message', 'followup') AND status = 'sent'").get(accountId, target).at ?? null,
    forTarget: (accountId, target) => db.prepare("SELECT action, status, detail, run_id AS runId, at FROM actions WHERE account_id = ? AND target = ? ORDER BY at").all(accountId, target),
  };

  const event = (entity, entityId, kind, text, runId = null) => db.prepare("INSERT INTO crm_events (entity, entity_id, at, kind, text, run_id) VALUES (?, ?, ?, ?, ?, ?)").run(entity, entityId, now(), kind, text, runId);
  const eventsFor = (entity, entityId) => db.prepare("SELECT at, kind, text, run_id AS runId FROM crm_events WHERE entity = ? AND entity_id = ? ORDER BY id").all(entity, entityId).map((e) => ({ ...e, runId: e.runId || undefined }));
  const workflowName = (workflowId) => (workflowId ? db.prepare("SELECT name FROM workflows WHERE id = ?").get(workflowId)?.name ?? null : null);
  const page = (limit, offset) => [Math.min(Math.max(1, Number(limit) || 50), 500), Math.max(0, Number(offset) || 0)];
  const newestFirst = (list) => list.sort((a, b) => b.at - a.at);

  // The UI gets a label next to the state id; the stored object stays exactly what the step wrote.
  const outreachView = (o) => (o ? { ...o, label: stateLabel(o.state) } : null);
  const CONTACT_FROM = "FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN workflows w ON w.id = c.source_workflow_id";
  const toContact = (r) => r && ({
    id: r.id, accountId: r.account_id, accountName: r.account_name ?? null, profileUrl: r.profile_url, name: r.name, headline: r.headline, location: r.location, degree: r.degree,
    stage: r.stage, tags: json(r.tags) || [], notes: r.notes, firstSeenAt: r.first_seen_at, lastActivityAt: r.last_activity_at,
    source: r.source_workflow_id || r.source_run_id ? { workflowId: r.source_workflow_id, workflowName: r.workflow_name ?? null, runId: r.source_run_id } : null,
    data: json(r.data) || {},
    outreach: outreachView(json(r.outreach)),
  });
  const contactRow = (id_) => db.prepare(`SELECT c.*, a.name AS account_name, w.name AS workflow_name ${CONTACT_FROM} WHERE c.id = ?`).get(id_);

  // Moves the stage only forward and only along the automatic stages; a change is written to the timeline so the owner can see why a person moved.
  function setStage(contactId, next, why, runId = null) {
    const cur = db.prepare("SELECT stage FROM contacts WHERE id = ?").get(contactId)?.stage;
    if (!cur || cur === next) return;
    db.prepare("UPDATE contacts SET stage = ?, last_activity_at = ? WHERE id = ?").run(next, now(), contactId);
    event("contact", contactId, "stage", `${cur} → ${next} (${why})`, runId);
  }
  function refreshStage(contactId, runId = null) {
    const c = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId);
    if (!c) return;
    const implied = stageFromSignals({ actions: actions.forTarget(c.account_id, c.profile_url), degree: c.degree, replied: !!c.replied });
    setStage(contactId, advanceStage(c.stage, implied), "automatic", runId);
  }

  // One row per person per account; a later snapshot updates it and never resets the stage, tags or notes the owner set.
  function upsertContact({ accountId, item, workflowId = null, runId = null }) {
    const existing = db.prepare("SELECT * FROM contacts WHERE account_id = ? AND profile_url = ?").get(accountId, item.profileUrl);
    const merged = mergeSnapshot(existing ? { ...existing, data: json(existing.data) } : null, item);
    let contactId = existing?.id;
    if (existing) db.prepare("UPDATE contacts SET name = ?, headline = ?, location = ?, degree = ?, data = ?, last_activity_at = ? WHERE id = ?").run(merged.name, merged.headline, merged.location, merged.degree, JSON.stringify(merged.data), now(), contactId);
    else {
      contactId = id();
      db.prepare("INSERT INTO contacts (id, account_id, profile_url, name, headline, location, degree, source_workflow_id, source_run_id, data, first_seen_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(contactId, accountId, item.profileUrl, merged.name, merged.headline, merged.location, merged.degree, workflowId, runId, JSON.stringify(merged.data), now(), now());
    }
    if (runId && !db.prepare("SELECT 1 FROM crm_events WHERE entity = 'contact' AND entity_id = ? AND kind = 'run' AND run_id = ?").get(contactId, runId)) event("contact", contactId, "run", `Seen in a run of ${workflowName(workflowId) || "a workflow"}`, runId);
    refreshStage(contactId, runId);
    return contactId;
  }

  function upsertPost({ accountId, item, workflowId = null, runId = null }) {
    const existing = db.prepare("SELECT * FROM posts WHERE account_id = ? AND post_key = ?").get(accountId, item.postKey);
    const data = { ...(json(existing?.data) || {}), ...item };
    let postId = existing?.id;
    if (existing) db.prepare("UPDATE posts SET post_url = COALESCE(?, post_url), author_name = COALESCE(?, author_name), author_url = COALESCE(?, author_url), text = COALESCE(?, text), data = ?, last_activity_at = ? WHERE id = ?").run(item.postUrl || null, item.authorName || null, item.authorUrl || null, item.text || null, JSON.stringify(data), now(), postId);
    else {
      postId = id();
      db.prepare("INSERT INTO posts (id, account_id, post_key, post_url, author_name, author_url, text, source_workflow_id, source_run_id, data, first_seen_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(postId, accountId, item.postKey, item.postUrl || null, item.authorName || null, item.authorUrl || null, item.text || null, workflowId, runId, JSON.stringify(data), now(), now());
    }
    if (runId && !db.prepare("SELECT 1 FROM crm_events WHERE entity = 'post' AND entity_id = ? AND kind = 'run' AND run_id = ?").get(postId, runId)) event("post", postId, "run", `Seen in a run of ${workflowName(workflowId) || "a workflow"}`, runId);
    return postId;
  }

  const ENGAGED = `EXISTS (SELECT 1 FROM actions x WHERE x.account_id = p.account_id AND x.target = p.post_key AND x.action IN (${ENGAGEMENT_ACTIONS.map((a) => `'${a}'`).join(",")}) AND x.status IN ('sent', 'already'))`;
  const toPost = (r) => r && ({
    id: r.id, accountId: r.account_id, postKey: r.post_key, postUrl: r.post_url, authorName: r.author_name, authorUrl: r.author_url, text: r.text,
    firstSeenAt: r.first_seen_at, lastActivityAt: r.last_activity_at, engagement: engagementOf(actions.forTarget(r.account_id, r.post_key)), data: json(r.data) || {},
  });

  const crm = {
    stages: () => STAGES,
    tags: () => db.prepare("SELECT DISTINCT j.value AS tag FROM contacts c, json_each(c.tags) j ORDER BY j.value COLLATE NOCASE").all().map((r) => r.tag),
    contacts: {
      list: ({ accountId = null, stage = null, tag = null, search = null, foundBy = null, outreachState = null, limit = 50, offset = 0 } = {}) => {
        const where = [];
        const args = [];
        if (accountId) { where.push("c.account_id = ?"); args.push(accountId); }
        if (foundBy) { where.push("c.source_workflow_id = ?"); args.push(foundBy); }
        if (outreachState) { where.push("json_extract(c.outreach, '$.state') = ?"); args.push(outreachState); }
        if (stage) { where.push("c.stage = ?"); args.push(stage); }
        if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(c.tags) j WHERE j.value = ?)"); args.push(tag); }
        if (String(search ?? "").trim()) { const q = `%${String(search).trim()}%`; where.push("(c.name LIKE ? OR c.headline LIKE ? OR c.profile_url LIKE ?)"); args.push(q, q, q); }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const [lim, off] = page(limit, offset);
        const rows = db.prepare(`SELECT c.*, a.name AS account_name, w.name AS workflow_name ${CONTACT_FROM} ${w} ORDER BY c.last_activity_at DESC, c.rowid DESC LIMIT ? OFFSET ?`).all(...args, lim, off).map(toContact);
        return { rows, total: db.prepare(`SELECT COUNT(*) AS n FROM contacts c ${w}`).get(...args).n };
      },
      get: (contactId) => {
        const c = toContact(contactRow(contactId));
        if (!c) return null;
        const fromLedger = actions.forTarget(c.accountId, c.profileUrl).filter((a) => a.action !== "followup").map((a) => ({ at: a.at, kind: "action", text: `${a.action}: ${a.status}${a.detail ? ` (${a.detail})` : ""}`, runId: a.runId || undefined }));
        const fromFollowups = followups.list({ accountId: c.accountId }).filter((f) => f.profileUrl === c.profileUrl).flatMap((f) => f.history.map((h) => ({ at: h.at, kind: "followup", text: `${h.status}${h.text ? `: ${h.text}` : ""}`, runId: h.runId })));
        return { ...c, timeline: newestFirst([...eventsFor("contact", c.id), ...fromLedger, ...fromFollowups]) };
      },
      find: (accountId, profileUrl) => toContact(db.prepare(`SELECT c.*, a.name AS account_name, w.name AS workflow_name ${CONTACT_FROM} WHERE c.account_id = ? AND c.profile_url = ?`).get(accountId, profileUrl)),
      upsert: upsertContact,
      // A stage set here is the owner's (or a workflow acting for them), so it may move in any direction; only the automatic rule is forward-only.
      update: (contactId, { stage, tags, notes } = {}, { why = "set by hand", runId = null } = {}) => {
        const cur = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId);
        if (!cur) throw new Error("Contact not found");
        if (stage !== undefined && stage !== null) {
          if (!isStage(stage)) throw new Error(`Unknown stage "${stage}"`);
          if (stage !== cur.stage) { db.prepare("UPDATE contacts SET stage = ? WHERE id = ?").run(stage, contactId); event("contact", contactId, "stage", `${cur.stage} → ${stage} (${why})`, runId); }
        }
        if (tags !== undefined) db.prepare("UPDATE contacts SET tags = ? WHERE id = ?").run(JSON.stringify(parseTags(tags)), contactId);
        if (notes !== undefined) db.prepare("UPDATE contacts SET notes = ? WHERE id = ?").run(String(notes ?? ""), contactId);
        db.prepare("UPDATE contacts SET last_activity_at = ? WHERE id = ?").run(now(), contactId);
        return toContact(contactRow(contactId));
      },
      addNote: (contactId, text, runId = null) => { event("contact", contactId, "note", text, runId); db.prepare("UPDATE contacts SET last_activity_at = ? WHERE id = ?").run(now(), contactId); },
      // A reply is the strongest automatic signal; it is kept on the contact so a later rerun cannot forget it.
      markReplied: (accountId, profileUrl, { item = null, runId = null } = {}) => {
        const contactId = upsertContact({ accountId, item: { kind: "person", ...(item || {}), profileUrl }, runId: null });
        db.prepare("UPDATE contacts SET replied = 1 WHERE id = ?").run(contactId);
        refreshStage(contactId, runId);
        return contactId;
      },
      refreshStage,
      getOutreach: (contactId) => json(db.prepare("SELECT outreach FROM contacts WHERE id = ?").get(contactId)?.outreach),
      setOutreach: (contactId, outreach) => db.prepare("UPDATE contacts SET outreach = ?, last_activity_at = ? WHERE id = ?").run(JSON.stringify(outreach), now(), contactId),
      // The owner's buttons in the person panel; each lands on the timeline so the history says who stopped or resumed the automation.
      setOutreachState: (contactId, action) => {
        const cur = json(db.prepare("SELECT outreach FROM contacts WHERE id = ?").get(contactId)?.outreach) || { state: "invited", sent: [] };
        let next;
        if (action === "stop") next = { ...cur, prevState: cur.state, state: "manual" };
        else if (action === "booked") { next = { ...cur, state: "booked" }; crm.contacts.update(contactId, { stage: "meeting" }, { why: "marked booked by hand" }); }
        else if (action === "dropped") { next = { ...cur, state: "dropped" }; crm.contacts.update(contactId, { stage: "dropped" }, { why: "dropped by hand" }); }
        else if (action === "resume") {
          const last = cur.sent?.[cur.sent.length - 1];
          const back = cur.prevState && !isTerminal(cur.prevState) ? cur.prevState : last ? sentState(last.kind) : "invited";
          next = { ...cur, state: back, prevState: null, lastCheckedAt: 0 };
        } else throw new Error(`Unknown outreach action "${action}"`);
        db.prepare("UPDATE contacts SET outreach = ?, last_activity_at = ? WHERE id = ?").run(JSON.stringify(next), now(), contactId);
        event("contact", contactId, "outreach", `${stateLabel(cur.state)} → ${stateLabel(next.state)} (by hand)`);
        return toContact(contactRow(contactId));
      },
    },
    outreachStates: () => OUTREACH_STATES,
    posts: {
      list: ({ accountId = null, search = null, engaged = null, limit = 50, offset = 0 } = {}) => {
        const where = [];
        const args = [];
        if (accountId) { where.push("p.account_id = ?"); args.push(accountId); }
        if (engaged === true) where.push(ENGAGED);
        if (engaged === false) where.push(`NOT ${ENGAGED}`);
        if (String(search ?? "").trim()) { const q = `%${String(search).trim()}%`; where.push("(p.author_name LIKE ? OR p.text LIKE ? OR p.post_url LIKE ?)"); args.push(q, q, q); }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const [lim, off] = page(limit, offset);
        const rows = db.prepare(`SELECT p.* FROM posts p ${w} ORDER BY p.last_activity_at DESC, p.rowid DESC LIMIT ? OFFSET ?`).all(...args, lim, off).map(toPost);
        return { rows, total: db.prepare(`SELECT COUNT(*) AS n FROM posts p ${w}`).get(...args).n };
      },
      get: (postId) => {
        const p = toPost(db.prepare("SELECT * FROM posts WHERE id = ?").get(postId));
        if (!p) return null;
        const fromLedger = actions.forTarget(p.accountId, p.postKey).map((a) => ({ at: a.at, kind: "action", text: `${a.action}: ${a.status}${a.detail ? ` (${a.detail})` : ""}`, runId: a.runId || undefined }));
        return { ...p, timeline: newestFirst([...eventsFor("post", p.id), ...fromLedger]) };
      },
      upsert: upsertPost,
    },
    // Every person and post a finished run handed between steps becomes or updates a CRM record, so nothing a run found is lost once the run page is gone.
    absorbRun: db.transaction(({ runId, workflowId, accountId, outputs }) => {
      const { people, posts: found } = peopleAndPostsIn(outputs);
      for (const item of people) upsertContact({ accountId, item, workflowId, runId });
      for (const item of found) upsertPost({ accountId, item, workflowId, runId });
      return { people: people.length, posts: found.length };
    }),
  };

  const FOLLOWUP_FROM = "FROM followups f LEFT JOIN accounts a ON a.id = f.account_id LEFT JOIN workflows w ON w.id = f.workflow_id";
  const toFollowup = (r) => {
    if (!r) return null;
    const steps = json(r.steps) || [];
    return {
      id: r.id, accountId: r.account_id, accountName: r.account_name ?? null, profileUrl: r.profile_url, name: r.name, workflowId: r.workflow_id, workflowName: r.workflow_name ?? null,
      stepIndex: r.step_index, totalSteps: steps.length, nextDueAt: r.next_due_at, status: r.status, lastSentAt: r.last_sent_at, history: json(r.history) || [],
      nodeId: r.node_id, steps, stopOnReply: !!r.stop_on_reply, perDay: r.per_day, failures: r.failures, data: json(r.data) || {},
    };
  };
  const followupRow = (fid) => toFollowup(db.prepare(`SELECT f.*, a.name AS account_name, w.name AS workflow_name ${FOLLOWUP_FROM} WHERE f.id = ?`).get(fid));
  const pushHistory = (fid, entry) => {
    const h = json(db.prepare("SELECT history FROM followups WHERE id = ?").get(fid)?.history) || [];
    h.push({ at: now(), ...entry });
    db.prepare("UPDATE followups SET history = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(h), now(), fid);
  };
  const close = (status) => (fid, entry) => {
    db.prepare("UPDATE followups SET status = ?, next_due_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'").run(status, now(), fid);
    pushHistory(fid, { status, ...entry });
    return followupRow(fid);
  };

  const followups = {
    // Returns the new row, or null when this person already has an active sequence on the account (the unique index decides, so concurrent enrolments cannot both succeed).
    enroll: ({ accountId, profileUrl, name, workflowId, nodeId, steps, stopOnReply, perDay, lastSentAt, data }) => {
      const fid = id();
      try {
        db.prepare("INSERT INTO followups (id, account_id, profile_url, name, workflow_id, node_id, steps, stop_on_reply, per_day, step_index, next_due_at, status, last_sent_at, history, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?, ?, ?)")
          .run(fid, accountId, profileUrl, name || null, workflowId || null, nodeId || null, JSON.stringify(steps), stopOnReply ? 1 : 0, perDay ?? null, dueAt(lastSentAt, steps[0].afterDays), lastSentAt, JSON.stringify([{ at: now(), status: "enrolled" }]), JSON.stringify(data || {}), now(), now());
      } catch (err) {
        if (/UNIQUE/.test(err.message)) return null;
        throw err;
      }
      return followupRow(fid);
    },
    hasActive: (accountId, profileUrl) => !!db.prepare("SELECT 1 FROM followups WHERE account_id = ? AND profile_url = ? AND status = 'active'").get(accountId, profileUrl),
    get: followupRow,
    list: ({ accountId = null, status = null } = {}) => {
      const where = [];
      const args = [];
      if (accountId) { where.push("f.account_id = ?"); args.push(accountId); }
      if (status) { where.push("f.status = ?"); args.push(status); }
      return db.prepare(`SELECT f.*, a.name AS account_name, w.name AS workflow_name ${FOLLOWUP_FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.status = 'active' DESC, COALESCE(f.next_due_at, f.updated_at) ASC`).all(...args).map(toFollowup);
    },
    // Active rows whose time has come, grouped by the scheduler into one run per account and workflow.
    due: (atMs = now(), accountId = null) => db.prepare(`SELECT f.*, a.name AS account_name, w.name AS workflow_name ${FOLLOWUP_FROM} WHERE f.status = 'active' AND f.next_due_at <= ? ${accountId ? "AND f.account_id = ?" : ""} ORDER BY f.next_due_at`).all(...(accountId ? [atMs, accountId] : [atMs])).map(toFollowup),
    cancel: (fid) => {
      const row = followupRow(fid);
      if (!row) throw new Error("Follow-up not found");
      if (row.status !== "active") return row;
      return close("cancelled")(fid, {});
    },
    // The step just sent becomes the base for the next gap; the last step closes the sequence as done.
    markSent: (fid, { text, runId = null }) => {
      const row = followupRow(fid);
      const at = now();
      const index = row.stepIndex + 1;
      const next = row.steps[index];
      db.prepare("UPDATE followups SET step_index = ?, last_sent_at = ?, failures = 0, next_due_at = ?, status = ?, updated_at = ? WHERE id = ?").run(index, at, next ? dueAt(at, next.afterDays) : null, next ? "active" : "done", at, fid);
      pushHistory(fid, { status: "sent", text, runId });
      if (!next) pushHistory(fid, { status: "done" });
      return followupRow(fid);
    },
    markReplied: (fid, entry = {}) => close("replied")(fid, entry),
    markDone: (fid, entry = {}) => close("done")(fid, entry),
    markFailed: (fid, entry = {}) => close("failed")(fid, entry),
    // Something stopped the send before it happened (the thread would not open or read); the row stays active and is tried again later, up to a limit the caller sets.
    retryLater: (fid, { at, detail, runId = null }) => {
      db.prepare("UPDATE followups SET failures = failures + 1, next_due_at = ?, updated_at = ? WHERE id = ?").run(at, now(), fid);
      pushHistory(fid, { status: "retry", text: detail, runId });
      return followupRow(fid);
    },
    // A reply seen by Check replies ends every stop-on-reply sequence for that person on the account.
    endOnReply: (accountId, profileUrl, runId = null) => {
      const ids = db.prepare("SELECT id FROM followups WHERE account_id = ? AND profile_url = ? AND status = 'active' AND stop_on_reply = 1").all(accountId, profileUrl).map((r) => r.id);
      for (const fid of ids) close("replied")(fid, { runId });
      return ids.length;
    },
  };

  const settings = {
    get: (key) => json(db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null),
    set: (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value)),
  };

  return { accounts, workflows, triggers, runs, actions, settings, crm, followups, close: () => db.close() };
}

module.exports = { openStore };
