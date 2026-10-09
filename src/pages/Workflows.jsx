// The list of workflows: what each one does at a glance, its account, whether it fires on its own, and how its last run went.
import { useEffect, useState } from "react";
import { Plus, Workflow } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Page, PageHeader, StatusBadge, StepBadge, ToneBadge } from "@/components/common";
import { ago } from "@/lib/runs";

const api = window.outreach;

export function WorkflowList({ workflows, accounts, defs, go, onNew }) {
  const [details, setDetails] = useState({});

  useEffect(() => {
    let live = true;
    Promise.all(workflows.map(async (w) => [w.id, { wf: await api.workflows.get(w.id).catch(() => null), last: (await api.runs.list(w.id).catch(() => []))[0] }]))
      .then((pairs) => live && setDetails(Object.fromEntries(pairs)));
    return () => { live = false; };
  }, [workflows]);

  return (
    <Page>
      <PageHeader title="Workflows" description="Each workflow is a chain of steps that runs on one LinkedIn account. Open one to see its runs and what they produced." actions={<Button onClick={onNew}><Plus />New workflow</Button>} />
      {workflows.length === 0 ? (
        <Card><EmptyState icon={Workflow} title="No workflows" action={<Button onClick={onNew}><Plus />New workflow</Button>}>Create one and add steps in the editor.</EmptyState></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {workflows.map((w) => {
            const d = details[w.id];
            const account = accounts.find((a) => a.id === w.accountId);
            return (
              <Card key={w.id} className="cursor-pointer gap-4 transition-shadow hover:shadow-md" onClick={() => go({ kind: "workflow", id: w.id })}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base leading-snug">{w.name}</CardTitle>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {w.templateKey && <ToneBadge tone="blue" title="Made from a template that ships with the app">Built-in</ToneBadge>}
                      {w.active ? <ToneBadge tone="green">Active</ToneBadge> : <ToneBadge>Manual</ToneBadge>}
                    </div>
                  </div>
                  <CardDescription>{account ? account.name : "No account chosen"}</CardDescription>
                </CardHeader>
                <CardContent>
                  {!d ? <Skeleton className="h-8 w-full" /> : (
                    <div className="flex flex-wrap items-center gap-1">
                      {(d.wf?.nodes || []).slice(0, 9).map((n, i) => (
                        <span key={n.id} className="flex items-center gap-1">{i > 0 && <span className="text-muted-foreground/50">›</span>}<span title={defs[n.type]?.label}><StepBadge def={defs[n.type]} size="sm" /></span></span>
                      ))}
                      {(d.wf?.nodes?.length || 0) > 9 && <span className="text-xs text-muted-foreground">+{d.wf.nodes.length - 9}</span>}
                    </div>
                  )}
                </CardContent>
                <CardFooter className="justify-between text-xs text-muted-foreground">
                  <span>{d?.wf ? `${d.wf.nodes.length} steps` : ""}</span>
                  {d?.last ? <span className="flex items-center gap-2">Last run {ago(d.last.startedAt)}<StatusBadge status={d.last.status} /></span> : <span>{d ? "Never run" : ""}</span>}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}
