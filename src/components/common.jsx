// Small pieces every screen shares: status badges, step icons, empty states, page headers, the run pipeline, item output and the confirm dialog.
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { icons, Box, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { TRIGGER_GROUPS, actionNoun, branchName, countsText, itemLink, itemTitle, sortHandles } from "@/lib/runs";

const TONES = {
  green: "border-success/25 bg-success/10 text-success",
  red: "border-destructive/25 bg-destructive/10 text-destructive",
  amber: "border-warning/30 bg-warning/12 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]",
  blue: "border-primary/25 bg-primary/10 text-primary",
  grey: "border-border bg-muted text-muted-foreground",
};
const STATUS_TONE = { running: "blue", finished: "green", done: "green", sent: "green", active: "blue", replied: "green", failed: "red", unverified: "red", stopped: "amber", interrupted: "amber", skipped: "grey", already: "grey", cancelled: "grey", capped: "amber" };

export function StatusBadge({ status, label, className, ...props }) {
  const tone = STATUS_TONE[status] || "grey";
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium capitalize", TONES[tone], className)} {...props}>
      {status === "running" ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {label || status}
    </Badge>
  );
}

export function ToneBadge({ tone = "grey", className, children, ...props }) {
  return <Badge variant="outline" className={cn("font-medium", TONES[tone], className)} {...props}>{children}</Badge>;
}

// Each catalog group gets one accent so a canvas reads by colour before you read labels.
export const GROUP_ACCENT = {
  Triggers: "text-emerald-600 bg-emerald-500/12 dark:text-emerald-400", Trigger: "text-emerald-600 bg-emerald-500/12 dark:text-emerald-400",
  Search: "text-sky-600 bg-sky-500/12 dark:text-sky-400", Feed: "text-cyan-600 bg-cyan-500/12 dark:text-cyan-400",
  Posts: "text-blue-600 bg-blue-500/12 dark:text-blue-400", Profile: "text-indigo-600 bg-indigo-500/12 dark:text-indigo-400",
  Messaging: "text-violet-600 bg-violet-500/12 dark:text-violet-400", LinkedIn: "text-blue-600 bg-blue-500/12 dark:text-blue-400",
  CRM: "text-amber-600 bg-amber-500/14 dark:text-amber-400", AI: "text-fuchsia-600 bg-fuchsia-500/12 dark:text-fuchsia-400",
  Logic: "text-slate-600 bg-slate-500/14 dark:text-slate-300",
};
export const GROUP_BAR = {
  Triggers: "bg-emerald-500", Trigger: "bg-emerald-500", Search: "bg-sky-500", Feed: "bg-cyan-500", Posts: "bg-blue-500", Profile: "bg-indigo-500",
  Messaging: "bg-violet-500", LinkedIn: "bg-blue-500", CRM: "bg-amber-500", AI: "bg-fuchsia-500", Logic: "bg-slate-400",
};

export function StepIcon({ def, className }) {
  const Icon = (def?.icon && icons[def.icon]) || Box;
  return <Icon className={cn("size-4", className)} />;
}

export function StepBadge({ def, size = "md" }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md", size === "sm" ? "size-6" : "size-8", GROUP_ACCENT[def?.group] || GROUP_ACCENT.Logic)}>
      <StepIcon def={def} className={size === "sm" ? "size-3.5" : "size-4"} />
    </span>
  );
}

export function EmptyState({ icon: Icon = Box, title, children, action, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-5" /></div>
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }) {
  return <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{label}</div>;
}

export function PageHeader({ title, description, actions, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className }) {
  return <div className={cn("mx-auto w-full max-w-7xl space-y-6 p-6 lg:p-8", className)}>{children}</div>;
}

// The chain a person reads first: each step that ran, and how many items it handed on.
export function Pipeline({ summary, defs, compact }) {
  const ran = (summary?.steps || []).filter((s) => s.state && s.state !== "skipped" && !TRIGGER_GROUPS.has(defs[s.type]?.group));
  if (!ran.length) return <span className="text-xs text-muted-foreground">nothing ran</span>;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", compact && "gap-0.5")}>
      {ran.map((s, i) => (
        <span key={s.nodeId} className="inline-flex items-center gap-1">
          <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs", s.state === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "bg-muted/50")}>
            <StepIcon def={defs[s.type]} className="size-3 opacity-70" />
            <span className="max-w-32 truncate">{defs[s.type]?.label || "deleted step"}</span>
            <span className="font-semibold tabular-nums">{s.state === "failed" ? "failed" : s.state === "running" ? "…" : countsText(s.counts)}</span>
          </span>
          {i < ran.length - 1 && <span className="text-muted-foreground/60">›</span>}
        </span>
      ))}
    </div>
  );
}

export function ActionsDone({ actions }) {
  const parts = Object.entries(actions || {}).map(([action, byStatus]) => {
    const sent = byStatus.sent || 0;
    const other = Object.entries(byStatus).filter(([s]) => s !== "sent").map(([s, n]) => `${n} ${s}`);
    return { key: action, text: `${sent} ${actionNoun(action, sent)}`, other: other.join(", ") };
  });
  if (!parts.length) return <span className="text-xs text-muted-foreground">none</span>;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {parts.map((p) => <span key={p.key}><span className="font-medium">{p.text}</span>{p.other && <span className="text-muted-foreground"> ({p.other})</span>}</span>)}
    </div>
  );
}

function ItemCard({ it }) {
  const link = itemLink(it);
  const ai = it.ai && typeof it.ai === "object" ? it.ai : null;
  return (
    <div className="space-y-1.5 rounded-lg border bg-card p-3 text-sm shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{itemTitle(it)}{it.degree && <span className="font-normal text-muted-foreground"> · {it.degree}</span>}</div>
          {(it.headline || it.authorHeadline) && <div className="line-clamp-2 text-xs text-muted-foreground">{it.headline || it.authorHeadline}</div>}
        </div>
        {link && <Button variant="ghost" size="icon-xs" asChild><a href={link} target="_blank" rel="noreferrer" title={link}><ExternalLink /></a></Button>}
      </div>
      {it.comment && <div className="text-xs"><span className="text-muted-foreground">Comment </span>“{it.comment}”</div>}
      {it.text && <div className="line-clamp-3 text-xs text-muted-foreground">{it.text}</div>}
      {it.evaluation && (
        <div className="flex items-start gap-2 text-xs">
          <ToneBadge tone={it.evaluation.qualified ? "green" : "grey"} className="tabular-nums">{it.evaluation.score ?? "?"}</ToneBadge>
          <span className="text-muted-foreground">{it.evaluation.reason}</span>
        </div>
      )}
      {ai && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {Object.entries(ai).map(([k, v]) => <span key={k} className="rounded bg-muted px-1.5 py-0.5"><span className="text-muted-foreground">{k} </span>{String(v)}</span>)}
        </div>
      )}
      {it.draft && <div className="rounded-md bg-muted/60 p-2 text-xs"><span className="text-muted-foreground">Draft </span>{it.draft}</div>}
      <div className="flex flex-wrap gap-1.5">
        {it.invitedWith !== undefined && <ToneBadge tone="green">Invited{it.invitedWith ? " with note" : ""}</ToneBadge>}
        {it.messaged && <ToneBadge tone="green">Messaged</ToneBadge>}
        {it.commented && <ToneBadge tone="green">Commented</ToneBadge>}
        {it.reposted && <ToneBadge tone="green">Reposted</ToneBadge>}
      </div>
    </div>
  );
}

export const handleLabel = (h) => (h === "out" ? "Output" : branchName(h));
export const handleTone = (h) => (/^(pass|true|replied|sent)$/.test(h) ? "green" : h === "needsYou" ? "amber" : "grey");

export function ItemOutput({ output, empty = "No output yet. Run the workflow, then pick a step to see what it produced." }) {
  if (!output || !Object.keys(output).length) return <EmptyState title="Nothing here yet">{empty}</EmptyState>;
  return (
    <div className="space-y-4">
      {sortHandles(Object.entries(output), ([h]) => h).map(([handle, items]) => (
        <section key={handle} className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{handleLabel(handle)}<ToneBadge tone={handleTone(handle)} className="tabular-nums">{items.length}</ToneBadge></div>
          {items.length === 0 && <p className="text-xs text-muted-foreground">No items went out this way.</p>}
          <div className="grid gap-2">{items.map((it, i) => <ItemCard key={i} it={it} />)}</div>
        </section>
      ))}
    </div>
  );
}

export function LogLines({ events, labelOf }) {
  return events.map((e, i) => (
    <div key={i} className={cn("flex gap-3 px-3 py-0.5 font-mono text-xs leading-5", e.type !== "log" && "bg-destructive/5 text-destructive")}>
      <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(e.at).toLocaleTimeString()}</span>
      <span className="min-w-0 break-words">{e.nodeId && labelOf && <span className="font-semibold">{labelOf(e.nodeId)}: </span>}{e.message}</span>
    </div>
  ));
}

const ConfirmContext = createContext(async () => false);

// One shared dialog replaces window.confirm, which Electron renders as an unstyled native box.
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const resolver = useRef(null);
  const confirm = useCallback((opts) => new Promise((resolve) => { resolver.current = resolve; setReq(opts); }), []);
  const close = (answer) => { resolver.current?.(answer); resolver.current = null; setReq(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!req} onOpenChange={(o) => !o && close(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{req?.title}</DialogTitle>
            {req?.description && <DialogDescription>{req.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button variant={req?.destructive ? "destructive" : "default"} onClick={() => close(true)}>{req?.confirmLabel || "Confirm"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmContext);
