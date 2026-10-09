// One workflow: its runs and what the selected run produced take the space; the diagram is a small preview that opens the full editor.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { AlertTriangle, ChevronDown, Ellipsis, ExternalLink, History, Loader2, PanelLeftClose, PanelLeftOpen, Pencil, Play, ScrollText, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ItemOutput, Loading, LogLines, StatusBadge, StepBadge, ToneBadge, useConfirm } from "@/components/common";
import { SimpleSelect } from "@/components/ParamEditors";
import { FlowPreview } from "@/components/flow";
import WorkflowEditor from "@/pages/WorkflowEditor";
import { FIRED_BY, TRIGGER_GROUPS, ago, countsText, duration, isLogEvent, stepStatus, when } from "@/lib/runs";
import { cn } from "@/lib/utils";

const api = window.outreach;
const NO_RUN = { id: null, active: false, events: [], outputs: {}, error: null, status: null };

function RunOutputs({ run, wf, defs, status }) {
  const [step, setStep] = useState(null);
  const [logOpen, setLogOpen] = useState(true);
  const logPanel = usePanelRef();
  const logRef = useRef(null);
  const steps = (wf?.nodes || []).filter((n) => status[n.id] || run.outputs?.[n.id]);
  // Default to the last step that produced something: that is usually what the person wants to see.
  const fallback = [...steps].reverse().find((n) => run.outputs?.[n.id] && !TRIGGER_GROUPS.has(defs[n.type]?.group))?.id || steps[0]?.id;
  const current = steps.some((n) => n.id === step) ? step : fallback;
  const log = run.events.filter(isLogEvent);
  const labelOf = (id) => defs[wf?.nodes.find((n) => n.id === id)?.type]?.label;
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log.length]);

  if (!run.id) return <EmptyState icon={Play} title="No run selected" className="h-full">Press Run, or pick a past run on the left.</EmptyState>;
  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel minSize={160}>
        <div className="flex h-full">
          <div className="w-60 shrink-0 overflow-y-auto border-r">
            <div className="space-y-0.5 p-2">
              {steps.length === 0 && <p className="p-2 text-xs text-muted-foreground">{run.active ? "Starting…" : "No step ran."}</p>}
              {steps.map((n) => {
                const s = status[n.id];
                // Steps with three or more branches put their counts on a second line so the step name still fits.
                const wide = Object.keys(s?.counts || {}).length > 2;
                const counts = (
                  <span className={cn("text-xs tabular-nums", wide ? "block truncate" : "shrink-0", s?.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    {s?.state === "running" ? <Loader2 className="size-3 animate-spin" /> : s?.state === "failed" ? "failed" : countsText(s?.counts)}
                  </span>
                );
                return (
                  <button key={n.id} onClick={() => setStep(n.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", current === n.id && "bg-accent")}>
                    <StepBadge def={defs[n.type]} size="sm" />
                    {wide ? <span className="min-w-0 flex-1"><span className="block truncate">{defs[n.type]?.label || n.type}</span>{counts}</span> : <><span className="min-w-0 flex-1 truncate">{defs[n.type]?.label || n.type}</span>{counts}</>}
                  </button>
                );
              })}
            </div>
          </div>
          <ScrollArea className="min-w-0 flex-1">
            <div className="p-4">
              {current && status[current]?.error && <Alert variant="destructive" className="mb-3"><AlertTriangle /><AlertDescription>{status[current].error}</AlertDescription></Alert>}
              <ItemOutput output={current ? run.outputs?.[current] : null} empty={run.active ? "Items appear here when this step finishes." : "This step handed nothing on."} />
            </div>
          </ScrollArea>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel panelRef={logPanel} defaultSize={150} minSize={90} collapsible collapsedSize={36} onResize={(s) => setLogOpen(s.inPixels > 40)}>
        <div className="flex h-full flex-col">
          <button className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => (logOpen ? logPanel.current?.collapse() : logPanel.current?.expand())}>
            <ScrollText className="size-3.5" />Log<span className="tabular-nums">({log.length})</span>
            <ChevronDown className={cn("ml-auto size-3.5 transition-transform", !logOpen && "rotate-180")} />
          </button>
          <div ref={logRef} className="min-h-0 flex-1 overflow-auto bg-muted/30 py-1">
            {log.length ? <LogLines events={log} labelOf={labelOf} /> : <p className="px-3 py-1 text-xs text-muted-foreground">Nothing logged yet.</p>}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default function WorkflowPage({ workflowId, catalog, defs, accounts, refresh, go, startEditing, initialRunId }) {
  const confirm = useConfirm();
  const [wf, setWf] = useState(null);
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(NO_RUN);
  const [problems, setProblems] = useState([]);
  const [triggers, setTriggers] = useState({});
  const [editing, setEditing] = useState(startEditing);
  const [diagramOpen, setDiagramOpen] = useState(true);
  const [runsOpen, setRunsOpen] = useState(true);
  const runsPanel = usePanelRef();
  const runId = useRef(null);
  runId.current = run.id;

  const loadRun = useCallback(async (id) => {
    const r = await api.runs.get(id);
    if (r) setRun({ id: r.id, active: r.status === "running", events: r.events, outputs: r.outputs, error: r.error, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, firedBy: r.firedBy });
  }, []);
  const loadTriggers = useCallback(() => api.workflows.triggers(workflowId).then((list) => setTriggers(Object.fromEntries(list.map((t) => [t.nodeId, t])))).catch(() => {}), [workflowId]);
  const loadRuns = useCallback(() => api.runs.list(workflowId).then((l) => { setRuns(l); return l; }), [workflowId]);

  useEffect(() => {
    api.workflows.get(workflowId).then(setWf).catch((e) => toast.error(e.message));
    loadRuns().then((l) => { const first = initialRunId || l[0]?.id; if (first) loadRun(first); });
    loadTriggers();
    return api.workflows.onTriggersChanged((e) => { if (e.workflowId === workflowId) loadTriggers(); });
  }, [workflowId, loadRun, loadRuns, loadTriggers, initialRunId]);

  useEffect(() => {
    const offEvent = api.runs.onEvent((e) => { if (e.workflowId === workflowId) setRun((r) => (r.id === e.runId ? { ...r, events: [...r.events, e] } : r)); });
    const offDone = api.runs.onFinished(async (e) => {
      if (e.workflowId !== workflowId) return;
      if (e.runId === runId.current) await loadRun(e.runId);
      loadRuns();
    });
    return () => { offEvent(); offDone(); };
  }, [workflowId, loadRun, loadRuns]);

  useEffect(() => { if (wf) api.workflows.validate(wf).then(setProblems).catch(() => {}); }, [wf]);

  const status = useMemo(() => stepStatus(run.events), [run.events]);

  async function persist(patch) {
    try {
      const saved = await api.workflows.save({ ...wf, ...patch });
      setWf(saved);
      await refresh();
    } catch (e) { toast.error(e.message); }
  }

  async function toggleActive(on) {
    try {
      await api.workflows.setActive(workflowId, on);
      setWf((w) => ({ ...w, active: on }));
      await refresh();
      setTimeout(loadTriggers, 500);
    } catch (e) { toast.error(e.message); }
  }

  async function start() {
    try {
      const id = await api.runs.start(workflowId);
      setRun({ ...NO_RUN, id, active: true, status: "running", startedAt: Date.now(), firedBy: "manual" });
      loadRuns();
    } catch (e) { toast.error(e.message); }
  }

  async function remove() {
    if (!(await confirm({ title: `Delete "${wf.name}"?`, description: "The workflow is removed. Its run records stay in Run history.", confirmLabel: "Delete", destructive: true }))) return;
    await api.workflows.remove(workflowId);
    await refresh();
    go({ kind: "workflows" });
  }

  if (!wf) return <Loading />;
  const canRun = problems.length === 0 && !!wf.accountId;
  const hasTimedTrigger = wf.nodes.some((n) => n.type === "schedule" || n.type === "pollApi");

  return (
    <div className="flex h-full min-h-[640px] flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{wf.name}</h1>
            {wf.templateKey && <ToneBadge tone="blue" className="shrink-0" title="Made from a template that ships with the app">Built-in</ToneBadge>}
          </div>
          <p className="text-xs text-muted-foreground">{wf.nodes.length} steps · {runs.length ? `last run ${ago(runs[0].startedAt)}` : "never run"}</p>
        </div>
        <SimpleSelect className="h-9 w-52" value={wf.accountId || ""} placeholder="Choose LinkedIn account" options={[["", "Choose LinkedIn account…"], ...accounts.map((a) => [a.id, a.name])]} onChange={(v) => persist({ accountId: v || null })} />
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-9 items-center gap-2 rounded-md border px-3">
              <Switch id="wf-active" data-testid="workflow-active" checked={!!wf.active} onCheckedChange={toggleActive} disabled={!hasTimedTrigger && !wf.active} />
              <Label htmlFor="wf-active" className="text-sm">{wf.active ? "Active" : "Inactive"}</Label>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{hasTimedTrigger ? "Active workflows fire their Schedule and Poll API triggers on their own while the app is open." : "Add a Schedule or Poll API trigger first; Active only matters for those."}</TooltipContent>
        </Tooltip>
        <Button variant="outline" data-testid="workflow-edit" onClick={() => setEditing(true)}><Pencil />Edit</Button>
        {run.active
          ? <Button variant="destructive" data-testid="workflow-stop" onClick={() => api.runs.stop(run.id)}><Square />Stop</Button>
          : <Button data-testid="workflow-run" onClick={start} disabled={!canRun} title={!wf.accountId ? "Choose a LinkedIn account first" : problems.length ? "Fix the problems first" : undefined}><Play />Run</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" title="More"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => go({ kind: "runs", workflowId })}><History />Run history</DropdownMenuItem>
            {run.id && <DropdownMenuItem onClick={() => go({ kind: "run", runId: run.id, from: { kind: "workflow", id: workflowId } })}><ExternalLink />Open run details</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={remove}><Trash2 />Delete workflow</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {problems.length > 0 && (
        <Alert className="border-warning/40 bg-warning/5">
          <AlertTriangle className="text-warning" />
          <AlertTitle>This workflow cannot run yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">{problems.map((p, i) => <li key={i}>{p.nodeId && <b>{defs[wf.nodes.find((n) => n.id === p.nodeId)?.type]?.label}: </b>}{p.message}</li>)}</ul>
            <Button variant="link" className="h-auto p-0" onClick={() => setEditing(true)}>Open the editor</Button>
          </AlertDescription>
        </Alert>
      )}
      {run.error && !problems.length && <Alert variant="destructive"><AlertTriangle /><AlertTitle>Run {run.status}</AlertTitle><AlertDescription>{run.error}</AlertDescription></Alert>}

      <Collapsible open={diagramOpen} onOpenChange={setDiagramOpen} asChild>
        <Card className="shrink-0 gap-0 overflow-hidden py-0">
          <div className="flex h-11 items-center gap-2 px-3">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="-ml-1 gap-1.5 px-2 font-medium"><ChevronDown className={cn("transition-transform", !diagramOpen && "-rotate-90")} />Workflow diagram</Button>
            </CollapsibleTrigger>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {!diagramOpen && wf.nodes.map((n) => <span key={n.id} title={defs[n.type]?.label}><StepBadge def={defs[n.type]} size="sm" /></span>)}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil />Edit steps</Button>
          </div>
          <CollapsibleContent>
            <div className="h-56 cursor-pointer border-t bg-muted/30" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
              <FlowPreview graph={wf} defs={defs} status={status} interactive={false} />
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card className="min-h-[380px] flex-1 overflow-hidden py-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel panelRef={runsPanel} defaultSize={300} minSize={220} maxSize={480} collapsible collapsedSize={44} onResize={(s) => setRunsOpen(s.inPixels > 60)}>
            {runsOpen ? (
              <div className="flex h-full flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
                  <span className="text-sm font-medium">Runs <span className="text-muted-foreground tabular-nums">{runs.length}</span></span>
                  <Button variant="ghost" size="icon-sm" onClick={() => runsPanel.current?.collapse()} title="Hide runs"><PanelLeftClose /></Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  {runs.length === 0 ? <EmptyState icon={History} title="No runs yet">Press Run to start one.</EmptyState> : (
                    <div className="space-y-0.5 p-2">
                      {runs.map((r) => (
                        <button key={r.id} data-testid="run-row" onClick={() => loadRun(r.id)} className={cn("flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left hover:bg-accent", run.id === r.id && "bg-accent")}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{when(r.startedAt)}</span>
                            <StatusBadge status={r.status} data-testid="run-status" />
                          </div>
                          <span className="text-xs text-muted-foreground">{FIRED_BY[r.firedBy] || r.firedBy} · {duration(r)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center py-2"><Button variant="ghost" size="icon-sm" onClick={() => runsPanel.current?.expand()} title="Show runs"><PanelLeftOpen /></Button></div>
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel minSize={360}>
            <div className="flex h-full flex-col">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
                {run.id ? (
                  <>
                    <StatusBadge status={run.status} />
                    <span className="truncate text-sm text-muted-foreground">{when(run.startedAt)} · {FIRED_BY[run.firedBy] || run.firedBy} · took {duration(run)}</span>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={() => go({ kind: "run", runId: run.id, from: { kind: "workflow", id: workflowId } })}>Run details<ExternalLink /></Button>
                  </>
                ) : <span className="text-sm font-medium">Output</span>}
              </div>
              <div className="min-h-0 flex-1"><RunOutputs run={run} wf={wf} defs={defs} status={status} /></div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Card>

      <WorkflowEditor open={editing} onOpenChange={setEditing} wf={wf} catalog={catalog} defs={defs} run={run} status={status} triggers={triggers}
        onSaved={async (saved) => { setWf(saved); await refresh(); loadTriggers(); }} onRun={start} onStop={() => api.runs.stop(run.id)} />
    </div>
  );
}
