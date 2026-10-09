// Run history across all workflows, and one run's full record: the graph as it ran, each step's settings and output, what it did on LinkedIn, and its log.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, History, Square, Trash2, Workflow } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionsDone, EmptyState, ItemOutput, Loading, LogLines, Page, PageHeader, Pipeline, StatusBadge, StepBadge, useConfirm } from "@/components/common";
import { SimpleSelect } from "@/components/ParamEditors";
import { FlowPreview } from "@/components/flow";
import { FIRED_BY, RUN_STATUSES, actionLink, countsText, duration, isLogEvent, paramText, shortLabel, when } from "@/lib/runs";
import { cn } from "@/lib/utils";

const api = window.outreach;

export function RunHistory({ defs, workflows, workflowId: initialWorkflow, go }) {
  const [filter, setFilter] = useState({ workflowId: initialWorkflow || "", status: "" });
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);

  const load = useCallback(async (before = null) => {
    const page = await api.runs.history({ workflowId: filter.workflowId || null, status: filter.status || null, before, limit: 50 });
    setRows((r) => (before ? [...(r || []), ...page] : page));
    setMore(page.length === 50);
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => api.runs.onFinished(() => load()), [load]);
  // Running rows show live durations and counts; a slow refresh is enough for a list.
  useEffect(() => {
    if (!rows?.some((r) => r.status === "running")) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [rows, load]);

  return (
    <Page>
      <PageHeader title="Run history" description="Every run of every workflow, newest first. Open one to see each step's settings, what it produced, and everything it did on LinkedIn." />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SimpleSelect className="h-9 w-60" value={filter.workflowId} options={[["", "All workflows"], ...workflows.map((w) => [w.id, w.name])]} onChange={(v) => setFilter({ ...filter, workflowId: v })} />
          <SimpleSelect className="h-9 w-40" value={filter.status} options={[["", "Any status"], ...RUN_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)])]} onChange={(v) => setFilter({ ...filter, status: v })} />
          <div className="flex-1" />
          {rows && <span className="text-xs text-muted-foreground">{rows.length}{more ? "+" : ""} runs</span>}
        </div>
        {!rows ? <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : rows.length === 0 ? <EmptyState icon={History} title="No runs match">Runs appear here when a workflow is run by hand, on a schedule, or by an API poll.</EmptyState>
          : (
            <Table>
              <TableHeader><TableRow><TableHead className="pl-4">Started</TableHead><TableHead>Workflow</TableHead><TableHead>Started by</TableHead><TableHead>Status</TableHead><TableHead>Took</TableHead><TableHead>Steps</TableHead><TableHead className="pr-4">Done on LinkedIn</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="run-row" className="cursor-pointer" onClick={() => go({ kind: "run", runId: r.id, from: { kind: "runs", workflowId: filter.workflowId || undefined } })}>
                    <TableCell className="pl-4 align-top font-medium">{when(r.startedAt)}</TableCell>
                    <TableCell className="align-top">{r.workflowName || <span className="text-muted-foreground">deleted workflow</span>}<div className="text-xs text-muted-foreground">{r.accountName}</div></TableCell>
                    <TableCell className="align-top text-muted-foreground">{FIRED_BY[r.firedBy] || r.firedBy}</TableCell>
                    <TableCell className="align-top"><StatusBadge status={r.status} data-testid="run-status" />{r.summary?.errors > 0 && <div className="mt-1 text-xs text-destructive">{r.summary.errors} {r.summary.errors === 1 ? "error" : "errors"}</div>}</TableCell>
                    <TableCell className="align-top tabular-nums text-muted-foreground">{duration(r)}</TableCell>
                    <TableCell className="max-w-md align-top whitespace-normal"><Pipeline summary={r.summary} defs={defs} /></TableCell>
                    <TableCell className="pr-4 align-top"><ActionsDone actions={r.actions} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        {more && <div className="border-t p-3 text-center"><Button variant="outline" size="sm" onClick={() => load(rows[rows.length - 1].startedAt)}>Load older runs</Button></div>}
      </Card>
    </Page>
  );
}

function Section({ title, description, action, defaultOpen = true, children, id }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card id={id} className="gap-0 overflow-hidden py-0">
        <CardHeader className={cn("py-3", open && "border-b")}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 text-left">
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
              <CardTitle className="text-base">{title}</CardTitle>
            </button>
          </CollapsibleTrigger>
          {description && open && <CardDescription className="pl-6">{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
        <CollapsibleContent><CardContent className="px-0">{children}</CardContent></CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function RunDetail({ runId, defs, go, onBack }) {
  const confirm = useConfirm();
  const [run, setRun] = useState(null);
  const [open, setOpen] = useState(null);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const load = useCallback(() => api.runs.get(runId).then(setRun), [runId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => api.runs.onFinished((e) => { if (e.runId === runId) load(); }), [runId, load]);
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [run?.status, load]);

  const steps = run?.summary?.steps || [];
  const status = useMemo(() => Object.fromEntries(steps.map((s) => [s.nodeId, { state: s.state, input: s.input, counts: s.counts, failedItems: s.failedItems, error: s.error }])), [steps]);

  if (!run) return <Loading />;
  const nodeOf = (id) => run.graph?.nodes.find((n) => n.id === id);
  const labelOf = (id) => defs[nodeOf(id)?.type]?.label || "deleted step";
  const log = run.events.filter(isLogEvent).filter((e) => !errorsOnly || e.type !== "log");

  async function remove() {
    if (!(await confirm({ title: "Delete this run's record?", description: "What it did on LinkedIn stays in the account history and still counts toward the caps.", confirmLabel: "Delete record", destructive: true }))) return;
    await api.runs.remove(runId);
    onBack();
  }

  function focusStep(id) {
    setOpen(id);
    setTimeout(() => document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  return (
    <Page>
      <PageHeader
        title={<span className="flex items-center gap-3">{run.workflowName || "Deleted workflow"}<StatusBadge status={run.status} data-testid="run-status" /></span>}
        description={`${when(run.startedAt)} · took ${duration(run)} · started by ${FIRED_BY[run.firedBy] || run.firedBy} · account ${run.accountName || "removed"}`}
        actions={<>
          {run.status === "running" && <Button variant="destructive" onClick={() => api.runs.stop(runId)}><Square />Stop</Button>}
          {run.workflowName && <Button variant="outline" onClick={() => go({ kind: "workflow", id: run.workflowId, runId })}><Workflow />Open workflow</Button>}
          {run.status !== "running" && <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={remove}><Trash2 />Delete record</Button>}
        </>}
      />
      {run.error && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{run.error}</AlertDescription></Alert>}

      {run.graph && (
        <Section title="Workflow as it ran" description={`${run.graphIsCurrent ? "This run is older than run snapshots, so this is the workflow as it is now; its settings may have changed since." : "The workflow as it was when this run started, even if you have edited it since."} Click a step for its settings and output.`}>
          <div className="h-72 bg-muted/30"><FlowPreview graph={run.graph} defs={defs} status={status} onNodeClick={focusStep} /></div>
        </Section>
      )}

      <Section title="Steps" description="Click a step for the settings it used, its log, and every item it produced.">
        <Table>
          <TableHeader><TableRow><TableHead className="pl-4">Step</TableHead><TableHead>Result</TableHead><TableHead className="text-right">In</TableHead><TableHead className="text-right">Out</TableHead><TableHead className="text-right">Errors</TableHead><TableHead className="pr-4 text-right">Took</TableHead></TableRow></TableHeader>
          <TableBody>
            {steps.map((s) => {
              const node = nodeOf(s.nodeId);
              const def = defs[s.type];
              const isOpen = open === s.nodeId;
              return (
                <Fragment key={s.nodeId}>
                  <TableRow id={`step-${s.nodeId}`} className={cn("cursor-pointer", isOpen && "bg-muted/50")} onClick={() => setOpen(isOpen ? null : s.nodeId)}>
                    <TableCell className="pl-4"><div className="flex items-center gap-2"><ChevronRight className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-90")} /><StepBadge def={def} size="sm" /><span className="font-medium">{def?.label || "deleted step"}</span></div></TableCell>
                    <TableCell><StatusBadge status={s.state === "done" ? "finished" : s.state} label={s.state} />{s.error && <div className="mt-1 max-w-sm text-xs whitespace-normal text-destructive">{s.error}</div>}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.input ?? "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">{countsText(s.counts) || "–"}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.failedItems ? "text-destructive" : "text-muted-foreground")}>{s.failedItems}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums text-muted-foreground">{s.ms != null ? duration({ startedAt: 0, finishedAt: s.ms }) : "–"}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/20 p-0 whitespace-normal">
                        <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                          <div className="space-y-4">
                            <div>
                              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings used</h4>
                              {def && node ? (
                                <dl className="space-y-2 text-sm">
                                  {def.params.map((p) => (
                                    <div key={p.key}><dt className="text-xs text-muted-foreground">{shortLabel(p.label)}</dt><dd className="break-words">{paramText(p, node.params?.[p.key]) || <span className="text-muted-foreground">blank</span>}</dd></div>
                                  ))}
                                  {def.params.length === 0 && <p className="text-muted-foreground">No settings.</p>}
                                </dl>
                              ) : <p className="text-sm text-muted-foreground">This step's settings were not recorded.</p>}
                            </div>
                            <div>
                              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Log</h4>
                              <div className="rounded-md border bg-background py-1">
                                {run.events.filter((e) => e.nodeId === s.nodeId && (e.type === "log" || e.type === "item.failed")).length
                                  ? <LogLines events={run.events.filter((e) => e.nodeId === s.nodeId && (e.type === "log" || e.type === "item.failed"))} />
                                  : <p className="px-3 py-1 text-xs text-muted-foreground">Nothing logged.</p>}
                              </div>
                            </div>
                          </div>
                          <div className="max-h-[520px] overflow-auto"><ItemOutput output={run.outputs[s.nodeId]} empty="This step handed nothing on." /></div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
            {steps.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No step ran.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Section>

      <Section title={`Done on LinkedIn (${run.actions.length})`} description="One row per invite, message, follow, reaction, comment or repost, with the result.">
        {run.actions.length === 0 ? <EmptyState title="Nothing done on LinkedIn">This run sent no invites or messages, and made no follows, reactions, comments or reposts.</EmptyState> : (
          <Table>
            <TableHeader><TableRow><TableHead className="pl-4">When</TableHead><TableHead>Action</TableHead><TableHead>Result</TableHead><TableHead className="pr-4">Who or what</TableHead></TableRow></TableHeader>
            <TableBody>
              {run.actions.map((a, i) => (
                <TableRow key={i}>
                  <TableCell className="pl-4 tabular-nums text-muted-foreground">{new Date(a.at).toLocaleTimeString()}</TableCell>
                  <TableCell className="capitalize">{a.action}</TableCell>
                  <TableCell><StatusBadge status={a.status} />{a.detail && <div className="mt-1 text-xs text-muted-foreground">{a.detail}</div>}</TableCell>
                  <TableCell className="max-w-md pr-4"><a className="inline-flex max-w-full items-center gap-1 truncate text-primary hover:underline" href={actionLink(a.target)} target="_blank" rel="noreferrer"><span className="truncate">{a.target}</span><ExternalLink className="size-3 shrink-0" /></a></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Full log" action={<div className="flex items-center gap-2"><Switch id="errors-only" checked={errorsOnly} onCheckedChange={setErrorsOnly} /><Label htmlFor="errors-only" className="text-sm font-normal">Errors only</Label></div>}>
        <div className="max-h-96 overflow-auto bg-muted/30 py-2">
          {log.length ? <LogLines events={log} labelOf={labelOf} /> : <p className="px-4 text-sm text-muted-foreground">Nothing logged.</p>}
        </div>
      </Section>
    </Page>
  );
}
