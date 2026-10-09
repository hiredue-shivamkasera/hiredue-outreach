// How a step looks on a React Flow canvas, shared by the editor, the workflow preview and the run detail.
import { useMemo } from "react";
import { ReactFlow, Background, Handle, Position } from "@xyflow/react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { branchName, clock, paramText, shortLabel, sortHandles, toFlowEdges } from "@/lib/runs";
import { GROUP_ACCENT, GROUP_BAR, StepIcon, handleLabel, handleTone } from "@/components/common";

function summary(def, params) {
  const first = def.params.find((p) => p.kind !== "number" && params[p.key] && typeof params[p.key] !== "object");
  if (!first) return def.description;
  return `${shortLabel(first.label)}: ${paramText(first, params[first.key]).slice(0, 70)}`;
}

function StepNode({ data, selected }) {
  const { def, status, problems, trigger, active } = data;
  if (!def) return <div className="rounded-lg border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive">Unknown step {data.type}</div>;
  const outs = sortHandles(def.outputs, (o) => o.handle);
  const isTrigger = data.type === "schedule" || data.type === "pollApi";
  return (
    <div className={cn(
      "relative w-60 overflow-visible rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow",
      selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      status?.state === "running" && "ring-2 ring-primary/60",
      status?.state === "failed" && "border-destructive/60",
      status?.state === "skipped" && "opacity-60",
      problems?.length > 0 && "border-warning",
    )}>
      <div className={cn("absolute inset-y-0 left-0 w-1 rounded-l-xl", GROUP_BAR[def.group] || "bg-slate-400")} />
      {def.input !== null && <Handle type="target" position={Position.Left} />}
      <div className="flex items-start gap-2.5 py-2.5 pr-3 pl-3.5">
        <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", GROUP_ACCENT[def.group] || GROUP_ACCENT.Logic)}><StepIcon def={def} className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{def.group}</div>
          <div className="truncate text-sm font-semibold leading-tight">{def.label}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">{summary(def, data.params)}</div>
        </div>
        {problems?.length > 0 && <AlertTriangle className="size-4 shrink-0 text-warning" title={problems.map((p) => p.message).join("\n")} />}
      </div>
      {status && (
        <div className="flex flex-wrap items-center gap-x-2 border-t px-3.5 py-1.5 text-[11px]">
          {status.state === "running" && <span className="inline-flex items-center gap-1 text-primary"><Loader2 className="size-3 animate-spin" />running on {status.input}</span>}
          {status.state === "done" && <span className="font-medium tabular-nums">{sortHandles(Object.entries(status.counts || {}), ([h]) => h).map(([h, n]) => (h === "out" ? `${n} out` : `${n} ${branchName(h)}`)).join(" · ")}</span>}
          {status.state === "skipped" && <span className="text-muted-foreground">skipped, nothing reached it</span>}
          {status.state === "failed" && <span className="font-medium text-destructive">failed</span>}
          {status.failedItems > 0 && <span className="text-destructive">{status.failedItems} errors</span>}
        </div>
      )}
      {isTrigger && active !== undefined && (
        <div className="border-t px-3.5 py-1.5 text-[11px]">
          {!active && <span className="text-muted-foreground">fires only when the workflow is Active</span>}
          {active && trigger?.nextAt && <span>next {clock(trigger.nextAt)}</span>}
          {active && trigger?.lastResult && <span className="text-muted-foreground"> · last: {trigger.lastResult}</span>}
          {trigger?.lastError && <div className="text-destructive">{trigger.lastError}</div>}
        </div>
      )}
      {outs.map((o, i) => (
        <Handle key={o.handle} id={o.handle} type="source" position={Position.Right} style={{ top: outs.length === 1 ? "50%" : outs.length === 2 ? `${30 + i * 40}%` : `${(100 * (i + 1)) / (outs.length + 1)}%` }}>
          {outs.length > 1 && <span className={cn("pointer-events-none absolute left-3 -translate-y-1/2 rounded bg-card px-1 text-[10px] font-medium whitespace-nowrap", { green: "text-success", amber: "text-warning" }[handleTone(o.handle)] || "text-muted-foreground")}>{handleLabel(o.handle)}</span>}
        </Handle>
      ))}
    </div>
  );
}

export const nodeTypes = { step: StepNode };

// A read-only canvas of a stored graph, with optional per-step status; used where the diagram is context, not the work.
export function FlowPreview({ graph, defs, status, onNodeClick, className, interactive = true }) {
  const { resolved } = useTheme();
  const nodes = useMemo(() => (graph?.nodes || []).map((n) => ({ id: n.id, type: "step", position: n.position, draggable: false, connectable: false, data: { type: n.type, params: n.params || {}, def: defs[n.type], status: status?.[n.id] } })), [graph, defs, status]);
  const edges = useMemo(() => toFlowEdges(graph?.edges), [graph]);
  return (
    <div className={cn("h-full w-full", className)}>
      <ReactFlow key={nodes.length} nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={resolved} fitView fitViewOptions={{ maxZoom: 0.9, padding: 0.12 }}
        nodesConnectable={false} nodesDraggable={false} elementsSelectable={!!onNodeClick} panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive} zoomOnDoubleClick={false} preventScrolling={interactive}
        onNodeClick={onNodeClick ? (_e, n) => onNodeClick(n.id) : undefined} proOptions={{ hideAttribution: true }}>
        <Background gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
