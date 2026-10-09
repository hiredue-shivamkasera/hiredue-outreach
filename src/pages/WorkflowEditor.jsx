// The full-screen workflow editor: grouped step palette, the canvas, and an inspector for the selected step's settings and last output. It edits a copy and saves only on Save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge, applyNodeChanges, applyEdgeChanges, useReactFlow } from "@xyflow/react";
import { usePanelRef } from "react-resizable-panels";
import { AlertTriangle, ChevronDown, Loader2, MousePointerClick, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Save, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ItemOutput, StepBadge, ToneBadge, useConfirm } from "@/components/common";
import { nodeTypes } from "@/components/flow";
import { ParamField, fieldSuggestions } from "@/components/ParamEditors";
import { useTheme } from "@/lib/theme";
import { groupsOf } from "@/lib/runs";

const api = window.outreach;

export const toFlow = (wf) => ({
  nodes: wf.nodes.map((n) => ({ id: n.id, type: "step", position: n.position, data: { type: n.type, params: n.params || {} } })),
  edges: wf.edges.map((e) => ({ ...e })),
});
export const fromFlow = (nodes, edges) => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, position: n.position, params: n.data.params })),
  edges: edges.map(({ id, source, sourceHandle, target }) => ({ id, source, sourceHandle: sourceHandle || "out", target })),
});

function Palette({ catalog: all, onAdd }) {
  // Hidden steps are superseded ones: existing workflows still show and run them, but nobody should add a new one.
  const catalog = all.filter((d) => !d.hidden);
  const groups = groupsOf(catalog);
  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-3">
        {groups.map((g) => (
          <Collapsible key={g} defaultOpen>
            <CollapsibleTrigger asChild>
              <button className="group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent">
                {g}<ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-0.5 pb-2">
              {catalog.filter((d) => d.group === g).map((d) => (
                <Tooltip key={d.type}>
                  <TooltipTrigger asChild>
                    <button data-testid={`palette-step-${d.type}`} draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-step", d.type); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={() => onAdd(d)} className="flex w-full cursor-grab items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent active:cursor-grabbing">
                      <StepBadge def={d} size="sm" /><span className="truncate">{d.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-64">{d.description}</TooltipContent>
                </Tooltip>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))}
        <p className="px-2 pt-2 text-xs text-muted-foreground">Click or drag a step onto the canvas, then drag from an output dot to an input dot to connect.</p>
      </div>
    </ScrollArea>
  );
}

function Inspector({ node, def, nodes, edges, output, status, problems, onParam, onDelete }) {
  if (!node || !def) return <EmptyState icon={MousePointerClick} title="No step selected" className="h-full">Click a step on the canvas to change its settings or see what it produced.</EmptyState>;
  const suggestions = fieldSuggestions(node.id, nodes, edges);
  return (
    <Tabs defaultValue="settings" className="flex h-full flex-col gap-0">
      <div className="space-y-3 border-b p-4">
        <div className="flex items-start gap-3">
          <StepBadge def={def} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{def.group}</div>
            <div className="font-semibold leading-tight">{def.label}</div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} title="Delete step"><Trash2 /></Button>
        </div>
        <p className="text-xs text-muted-foreground">{def.description}</p>
        <TabsList className="w-full"><TabsTrigger value="settings">Settings</TabsTrigger><TabsTrigger value="output">Last output</TabsTrigger></TabsList>
      </div>
      <TabsContent value="settings" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {problems.map((p, i) => <div key={i} className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"><AlertTriangle className="size-3.5 shrink-0 text-warning" />{p.message}</div>)}
            {status?.error && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{status.error}</div>}
            {def.params.length === 0 && <p className="text-sm text-muted-foreground">This step has no settings.</p>}
            {def.params.map((p) => <ParamField key={p.key} p={p} value={node.data.params[p.key]} onChange={(v) => onParam(p.key, v)} suggestions={suggestions} />)}
          </div>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="output" className="min-h-0 flex-1">
        <ScrollArea className="h-full"><div className="p-4"><ItemOutput output={output} /></div></ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

function EditorBody({ wf, catalog, defs, run, status, triggers, onClose, onSaved, onRun, onStop }) {
  const { resolved } = useTheme();
  const confirm = useConfirm();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const initial = useMemo(() => toFlow(wf), [wf]);
  const [name, setName] = useState(wf.name);
  const [nodes, setNodes] = useState(initial.nodes);
  const [edges, setEdges] = useState(initial.edges);
  const [selectedId, setSelectedId] = useState(null);
  const [problems, setProblems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const paletteRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const wrapper = useRef(null);

  // The dialog's zoom animation and the panels' first layout both resize the canvas after React Flow's own fit, so refit while the editor is settling.
  const openedAt = useRef(Date.now());
  const refit = useCallback(() => { if (Date.now() - openedAt.current < 1500) setTimeout(() => fitView({ maxZoom: 1, padding: 0.15 }), 50); }, [fitView]);
  useEffect(() => { const t = setTimeout(() => fitView({ maxZoom: 1, padding: 0.15 }), 400); return () => clearTimeout(t); }, [fitView]);

  // Validation runs in the main process against the same rules the engine enforces.
  useEffect(() => {
    const t = setTimeout(() => api.workflows.validate(fromFlow(nodes, edges)).then(setProblems).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const viewNodes = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, def: defs[n.data.type], status: status[n.id], problems: problems.filter((p) => p.nodeId === n.id), trigger: triggers[n.id], active: wf.active } })), [nodes, defs, status, problems, triggers, wf.active]);

  const onNodesChange = useCallback((c) => { setNodes((ns) => applyNodeChanges(c, ns)); if (c.some((x) => x.type !== "select" && x.type !== "dimensions")) setDirty(true); }, []);
  const onEdgesChange = useCallback((c) => { setEdges((es) => applyEdgeChanges(c, es)); if (c.some((x) => x.type !== "select")) setDirty(true); }, []);
  const onConnect = useCallback((c) => {
    const handle = c.sourceHandle || "out";
    setEdges((es) => addEdge({ ...c, sourceHandle: handle, id: `${c.source}-${handle}-${c.target}-${Date.now()}` }, es));
    setDirty(true);
  }, []);

  function addStep(def, position) {
    const id = `${def.type}-${Math.random().toString(36).slice(2, 7)}`;
    const params = Object.fromEntries(def.params.map((p) => [p.key, structuredClone(p.default ?? "")]));
    const right = nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: "step", selected: true, position: position || { x: right + 300, y: 120 }, data: { type: def.type, params } }]);
    setSelectedId(id);
    if (!inspectorOpen) inspectorRef.current?.expand();
    setDirty(true);
  }

  function onDrop(e) {
    e.preventDefault();
    const def = defs[e.dataTransfer.getData("application/x-step")];
    if (def) addStep(def, screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 30 }));
  }

  function setParam(key, value) {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n)));
    setDirty(true);
  }

  function deleteSelected() {
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await api.workflows.save({ id: wf.id, name: name.trim() || "Untitled workflow", accountId: wf.accountId, active: wf.active, ...fromFlow(nodes, edges) });
      setDirty(false);
      await onSaved(saved);
      return true;
    } catch (e) { toast.error(`Could not save: ${e.message}`); return false; } finally { setSaving(false); }
  }

  async function close() {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", description: "Your edits to this workflow have not been saved.", confirmLabel: "Discard", destructive: true }))) return;
    onClose();
  }

  async function saveAndRun() {
    if (dirty && !(await save())) return;
    onRun();
  }

  const selected = nodes.find((n) => n.id === selectedId);
  const nodeLabel = (id) => defs[nodes.find((n) => n.id === id)?.data.type]?.label;
  const togglePanel = (ref, open) => (open ? ref.current?.collapse() : ref.current?.expand());

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="icon-sm" onClick={() => togglePanel(paletteRef, paletteOpen)} title="Steps panel">{paletteOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</Button>
        <DialogTitle className="sr-only">Edit workflow</DialogTitle>
        <DialogDescription className="sr-only">Add, connect and configure the steps of this workflow.</DialogDescription>
        <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="h-8 max-w-sm border-transparent bg-transparent text-base font-semibold shadow-none hover:border-input focus-visible:border-input" />
        {dirty ? <ToneBadge tone="amber" data-testid="editor-dirty">Unsaved changes</ToneBadge> : <ToneBadge>Saved</ToneBadge>}
        {problems.length > 0 && <ToneBadge tone="red"><AlertTriangle className="size-3" />{problems.length} {problems.length === 1 ? "problem" : "problems"}</ToneBadge>}
        <div className="flex-1" />
        {run.active
          ? <Button variant="destructive" size="sm" onClick={onStop}><Square />Stop</Button>
          : <Button variant="outline" size="sm" onClick={saveAndRun} disabled={problems.length > 0 || !wf.accountId} title={!wf.accountId ? "Choose a LinkedIn account on the workflow page first" : undefined}><Play />Run</Button>}
        <Button size="sm" data-testid="workflow-save" onClick={save} disabled={!dirty || saving}>{saving ? <Loader2 className="animate-spin" /> : <Save />}Save</Button>
        <Button variant="ghost" size="icon-sm" onClick={() => togglePanel(inspectorRef, inspectorOpen)} title="Settings panel">{inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}</Button>
        <Button variant="ghost" size="icon-sm" onClick={close} title="Close editor"><X /></Button>
      </header>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel panelRef={paletteRef} defaultSize={220} minSize={180} maxSize={360} collapsible onResize={(s) => setPaletteOpen(s.inPixels > 0)} className="bg-sidebar">
          <Palette catalog={catalog} onAdd={(d) => addStep(d)} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel minSize={320} onResize={refit}>
          <div ref={wrapper} data-testid="editor-canvas" className="relative h-full bg-muted/30" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
            <ReactFlow nodes={viewNodes} edges={edges} nodeTypes={nodeTypes} colorMode={resolved} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              onNodeClick={(_e, n) => { setSelectedId(n.id); if (!inspectorOpen) inspectorRef.current?.expand(); }} onPaneClick={() => setSelectedId(null)}
              fitView fitViewOptions={{ maxZoom: 1, padding: 0.15 }} deleteKeyCode={["Backspace", "Delete"]} proOptions={{ hideAttribution: true }}>
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="!rounded-md !border" nodeColor="color-mix(in oklch, var(--muted-foreground) 45%, transparent)" maskColor="color-mix(in oklch, var(--background) 70%, transparent)" />
            </ReactFlow>
            {problems.length > 0 && (
              <div className="absolute top-3 left-3 max-w-md rounded-lg border border-warning/40 bg-card/95 p-3 text-xs shadow-md backdrop-blur" data-testid="editor-problems">
                <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="size-3.5 text-warning" />Fix these before running</div>
                <ul className="space-y-0.5">
                  {problems.map((p, i) => (
                    <li key={i}>{p.nodeId ? <button className="font-semibold hover:underline" onClick={() => setSelectedId(p.nodeId)}>{nodeLabel(p.nodeId) || "Step"}: </button> : null}<span className="text-muted-foreground">{p.message}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel panelRef={inspectorRef} defaultSize={350} minSize={300} maxSize={620} collapsible onResize={(s) => setInspectorOpen(s.inPixels > 0)} className="bg-background">
          <Inspector node={selected} def={selected && defs[selected.data.type]} nodes={nodes} edges={edges} output={selected ? run.outputs?.[selected.id] : null}
            status={selected && status[selected.id]} problems={problems.filter((p) => p.nodeId === selectedId)} onParam={setParam} onDelete={deleteSelected} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export default function WorkflowEditor({ open, onOpenChange, ...props }) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} className="flex h-[100vh] w-[100vw] max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none">
        {open && <ReactFlowProvider><EditorBody {...props} onClose={() => onOpenChange(false)} /></ReactFlowProvider>}
      </DialogContent>
    </Dialog>
  );
}
