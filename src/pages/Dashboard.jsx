// The landing page: what the accounts did in the last day, the latest runs, and the people those runs found.
import { useEffect, useState } from "react";
import { ArrowRight, History, MessageSquare, Reply, Sparkles, UserPlus, Users, Workflow, Zap } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionsDone, EmptyState, Page, PageHeader, Pipeline, StatusBadge, ToneBadge } from "@/components/common";
import { FIRED_BY, ago, duration, itemLink, when } from "@/lib/runs";

const api = window.outreach;
const DAY = 86_400_000;

function Kpi({ name, label, value, sub, icon: Icon, loading }) {
  return (
    <Card data-testid={`kpi-${name}`} className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-2 text-xs font-medium"><Icon className="size-3.5" />{label}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {loading ? <Skeleton className="h-8 w-16" /> : <div className="text-3xl font-semibold tracking-tight tabular-nums">{value}</div>}
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// People from the newest runs' final steps, used when the CRM is not there to ask.
async function peopleFromRuns(runs) {
  const people = [];
  for (const r of runs.filter((x) => x.status !== "running").slice(0, 5)) {
    const full = await api.runs.get(r.id);
    const seen = new Set();
    for (const out of Object.values(full?.outputs || {})) for (const items of Object.values(out)) for (const it of items) {
      if (it.kind !== "person" || !it.profileUrl) continue;
      const prev = people.find((p) => p.profileUrl === it.profileUrl);
      if (prev) { if (it.evaluation && !prev.evaluation) prev.evaluation = it.evaluation; continue; }
      if (!seen.has(it.profileUrl)) { seen.add(it.profileUrl); people.push({ ...it, at: r.startedAt, workflowName: r.workflowName }); }
    }
    if (people.length >= 8) break;
  }
  return people.slice(0, 8);
}

export default function Dashboard({ defs, workflows, accounts, go }) {
  const [runs, setRuns] = useState(null);
  const [kpi, setKpi] = useState(null);
  const [people, setPeople] = useState(null);

  useEffect(() => {
    let live = true;
    async function load() {
      const recent = await api.runs.history({ limit: 50 });
      if (!live) return;
      setRuns(recent);
      const since = Date.now() - DAY;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const ledgers = await Promise.all(accounts.map((a) => api.accounts.actions(a.id).catch(() => [])));
      const sent = (action) => ledgers.flat().filter((x) => x.action === action && x.status === "sent" && x.at >= since).length;
      let replies = null;
      if (api.crm?.contacts?.list) replies = (await api.crm.contacts.list({ stage: "replied", limit: 1 }).catch(() => null))?.total ?? null;
      const capPerAccount = defs.connect?.params.find((p) => p.key === "perDay")?.default ?? null;
      if (!live) return;
      setKpi({
        runsToday: recent.filter((r) => r.startedAt >= today.getTime()).length,
        running: recent.filter((r) => r.status === "running").length,
        invites: sent("connect"),
        cap: capPerAccount && accounts.length ? capPerAccount * accounts.length : null,
        messages: sent("message"), followups: sent("followup"), replies,
      });
      let latest = null;
      if (api.crm?.contacts?.list) latest = (await api.crm.contacts.list({ limit: 8 }).catch(() => null))?.rows?.map((c) => ({ ...c.data, ...c, at: c.lastActivityAt, workflowName: c.source?.workflowName })) ?? null;
      if (!latest) latest = await peopleFromRuns(recent);
      if (live) setPeople(latest);
    }
    load().catch(() => { setRuns([]); setPeople([]); });
    const off = api.runs.onFinished(() => load().catch(() => {}));
    return () => { live = false; off(); };
  }, [accounts, defs]);

  const active = workflows.filter((w) => w.active).length;
  return (
    <Page>
      <PageHeader title="Dashboard" description="What your LinkedIn accounts did in the last 24 hours, the latest runs, and the people they found." actions={<Button onClick={() => go({ kind: "workflows" })}><Workflow />Workflows</Button>} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Kpi name="runs" label="Runs today" icon={Zap} loading={!kpi} value={kpi?.runsToday} sub={kpi?.running ? `${kpi.running} running now` : "none running"} />
        <Kpi name="invites" label="Invites sent (24h)" icon={UserPlus} loading={!kpi} value={kpi && (kpi.cap ? <>{kpi.invites}<span className="text-lg font-normal text-muted-foreground"> / {kpi.cap}</span></> : kpi.invites)} sub={kpi?.cap ? `cap ${kpi.cap / accounts.length} per account` : "no accounts yet"} />
        <Kpi name="messages" label="Messages sent (24h)" icon={MessageSquare} loading={!kpi} value={kpi && kpi.messages + kpi.followups} sub={kpi ? `${kpi.messages} first, ${kpi.followups} follow-ups` : null} />
        <Kpi name="replies" label="People who replied" icon={Reply} loading={!kpi} value={kpi?.replies ?? "–"} sub={kpi?.replies == null ? "needs the CRM" : "stage Replied in the CRM"} />
        <Kpi name="active-workflows" label="Active workflows" icon={Workflow} loading={!kpi} value={active} sub={`of ${workflows.length} workflows`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Recent runs</CardTitle>
            <CardDescription>Each step that ran, and how many items it handed on.</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={() => go({ kind: "runs" })}>All runs<ArrowRight /></Button></CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {!runs ? <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              : runs.length === 0 ? <EmptyState icon={History} title="No runs yet">Open a workflow and press Run. Its results show up here.</EmptyState>
              : (
                <Table>
                  <TableHeader><TableRow><TableHead className="pl-4">Workflow</TableHead><TableHead>Status</TableHead><TableHead>Steps</TableHead><TableHead className="pr-4">On LinkedIn</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {runs.slice(0, 8).map((r) => (
                      <TableRow key={r.id} data-testid="run-row" className="cursor-pointer" onClick={() => go({ kind: "run", runId: r.id, from: { kind: "dashboard" } })}>
                        <TableCell className="pl-4 align-top">
                          <div className="font-medium">{r.workflowName || <span className="text-muted-foreground">deleted workflow</span>}</div>
                          <div className="text-xs text-muted-foreground">{ago(r.startedAt)} · {FIRED_BY[r.firedBy] || r.firedBy} · {duration(r)}</div>
                        </TableCell>
                        <TableCell className="align-top"><StatusBadge status={r.status} data-testid="run-status" /></TableCell>
                        <TableCell className="max-w-md align-top whitespace-normal"><Pipeline summary={r.summary} defs={defs} /></TableCell>
                        <TableCell className="pr-4 align-top"><ActionsDone actions={r.actions} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Latest people</CardTitle>
            <CardDescription>Found or qualified by recent runs.</CardDescription>
            {api.crm && <CardAction><Button variant="ghost" size="sm" onClick={() => go({ kind: "people" })}>CRM<ArrowRight /></Button></CardAction>}
          </CardHeader>
          <CardContent className="px-0">
            {!people ? <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              : people.length === 0 ? <EmptyState icon={Users} title="No people yet">People that runs find or qualify appear here.</EmptyState>
              : (
                <ul className="divide-y">
                  {people.map((p) => (
                    <li key={p.profileUrl || p.id} className="space-y-1 px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <a className="truncate text-sm font-medium hover:underline" href={itemLink(p) || undefined} target="_blank" rel="noreferrer">{p.name || p.profileUrl}</a>
                        {p.evaluation?.score != null && <ToneBadge tone={p.evaluation.qualified ? "green" : "grey"} className="tabular-nums">{p.evaluation.score}</ToneBadge>}
                      </div>
                      {p.headline && <div className="truncate text-xs text-muted-foreground">{p.headline}</div>}
                      {(p.evaluation?.reason || p.ai?.reason) && <div className="flex gap-1.5 text-xs"><Sparkles className="mt-0.5 size-3 shrink-0 text-fuchsia-500" /><span className="line-clamp-2">{p.evaluation?.reason || p.ai?.reason}</span></div>}
                      <div className="text-[11px] text-muted-foreground">{p.workflowName ? `${p.workflowName} · ` : ""}{when(p.at)}</div>
                    </li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
