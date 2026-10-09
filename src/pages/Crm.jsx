// The CRM: every person and post the workflows touched, with filters, and a side sheet to read the history, follow the outreach sequence, and set stage, tags and notes by hand.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, CalendarCheck, Database, ExternalLink, Loader2, MessagesSquare, Newspaper, Play, Search, Sparkles, Square, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { EmptyState, Loading, Page, PageHeader, StatusBadge, ToneBadge, useConfirm } from "@/components/common";
import { SimpleSelect } from "@/components/ParamEditors";
import { ago, until, when } from "@/lib/runs";
import { cn } from "@/lib/utils";

const api = window.outreach;
const PAGE = 50;
const STAGE_LABEL = { calendar_sent: "Calendar sent", meeting: "Meeting booked" };
const DEFAULT_STAGES = ["new", "invited", "connected", "messaged", "replied", "calendar_sent", "qualified", "meeting", "won", "lost", "dropped"].map((id) => ({ id, label: STAGE_LABEL[id] || id[0].toUpperCase() + id.slice(1) }));
const STAGE_TONE = { new: "grey", invited: "blue", connected: "blue", messaged: "blue", replied: "green", calendar_sent: "green", qualified: "green", meeting: "green", won: "green", lost: "red", dropped: "grey" };
const SENT_KIND = { intro: "Intro", followup1: "Follow-up 1", followup2: "Follow-up 2", calendar: "Calendar link", check_accepted: "Check the invite was accepted", check_booked: "Check for a booking", drop: "Drop if still silent" };
const sentKind = (k) => SENT_KIND[k] || String(k || "message").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase();

export function StageBadge({ stage, stages }) {
  return <ToneBadge tone={STAGE_TONE[stage] || "grey"}>{stages.find((s) => s.id === stage)?.label || stage}</ToneBadge>;
}

// needs_you is the one state that asks the person to act, so it is the only amber; terminal states recede.
function outreachTone(o, states) {
  if (o.state === "needs_you") return "amber";
  if (o.state === "booked") return "green";
  return states.find((s) => s.id === o.state)?.terminal ? "grey" : "blue";
}

export function OutreachBadge({ outreach, states, ...props }) {
  if (!outreach) return null;
  return <ToneBadge tone={outreachTone(outreach, states)} {...props}>{outreach.label || states.find((s) => s.id === outreach.state)?.label || outreach.state}</ToneBadge>;
}

function Unavailable({ what }) {
  return <Card><EmptyState icon={Database} title="The CRM is not available in this build">{what} appear here once the app's CRM storage is in place. Runs keep working without it.</EmptyState></Card>;
}

// Loads one page of a CRM list at a time; a missing or failing backend reads as "unavailable", never as an empty CRM.
function useCrmList(fetcher, filter) {
  const [state, setState] = useState({ rows: null, total: 0, error: null });
  const load = useCallback(async (offset = 0) => {
    if (!fetcher) return setState({ rows: [], total: 0, error: "missing" });
    try {
      const res = await fetcher({ ...filter, limit: PAGE, offset });
      setState((s) => ({ rows: offset ? [...(s.rows || []), ...res.rows] : res.rows, total: res.total, error: null }));
    } catch (e) { setState({ rows: [], total: 0, error: e.message }); }
  }, [fetcher, filter]);
  useEffect(() => { load(0); }, [load]);
  return { ...state, load };
}

function Timeline({ entries }) {
  if (!entries?.length) return <p className="text-sm text-muted-foreground">No history yet.</p>;
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {entries.map((t, i) => (
        <li key={i} className="relative">
          <span className={cn("absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-background", t.kind === "stage" ? "bg-primary" : t.kind === "action" || t.kind === "followup" ? "bg-success" : t.kind === "note" ? "bg-warning" : "bg-muted-foreground")} />
          <div className="text-sm">{t.text}</div>
          <div className="text-xs text-muted-foreground">{when(t.at)} · {t.kind}</div>
        </li>
      ))}
    </ol>
  );
}

function TagEditor({ tags, onChange, suggestions }) {
  const [draft, setDraft] = useState("");
  const add = (t) => { const v = t.trim(); if (v && !tags.includes(v)) onChange([...tags, v]); setDraft(""); };
  const unused = suggestions.filter((s) => !tags.includes(s) && (!draft || s.toLowerCase().includes(draft.toLowerCase()))).slice(0, 8);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => <Badge key={t} variant="secondary" className="gap-1 pr-1">{t}<button onClick={() => onChange(tags.filter((x) => x !== t))} className="rounded-full p-0.5 hover:bg-background" title={`Remove ${t}`}><X className="size-3" /></button></Badge>)}
        {tags.length === 0 && <span className="text-xs text-muted-foreground">No tags</span>}
      </div>
      <Input value={draft} placeholder="Add a tag and press Enter" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); } }} />
      {unused.length > 0 && <div className="flex flex-wrap gap-1">{unused.map((s) => <Button key={s} variant="outline" size="xs" onClick={() => add(s)}>+ {s}</Button>)}</div>}
    </div>
  );
}

// A date the sequence never reached (a 1st-degree person was never invited) is left out rather than shown as a dash.
function Dated({ label, at }) {
  if (!at) return null;
  return <><dt className="text-muted-foreground">{label}</dt><dd>{when(at)}</dd></>;
}

function OutreachSection({ c, states, busy, onAction }) {
  const o = c.outreach;
  if (!o) return null;
  const terminal = !!states.find((s) => s.id === o.state)?.terminal;
  return (
    <section className="space-y-3" data-testid="outreach-section">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><MessagesSquare className="size-4 text-violet-500" />Outreach</h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <OutreachBadge outreach={o} states={states} data-testid="outreach-state" />
        {o.nextAction && <span className="text-muted-foreground">Next: {sentKind(o.nextAction.kind)}, <span title={when(o.nextAction.at)}>{until(o.nextAction.at)}</span></span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {(o.state === "needs_you" || o.state === "manual") && <Button size="sm" disabled={!!busy} onClick={() => onAction("resume")}>{busy === "resume" ? <Loader2 className="animate-spin" /> : <Play />}Resume automation</Button>}
        {!terminal && o.state !== "manual" && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onAction("stop")}>{busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />}Stop automation</Button>}
        {o.state !== "booked" && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onAction("booked")}>{busy === "booked" ? <Loader2 className="animate-spin" /> : <CalendarCheck />}Mark meeting booked</Button>}
        {o.state !== "dropped" && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={!!busy} onClick={() => onAction("dropped")}>{busy === "dropped" ? <Loader2 className="animate-spin" /> : <X />}Drop</Button>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <Dated label="Invited" at={o.invitedAt} />
        <Dated label="Connected" at={o.connectedAt} />
        <Dated label="Inbox checked" at={o.lastCheckedAt} />
      </dl>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Messages sent</div>
        {(o.sent || []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing sent yet.</p> : (
          <ul className="space-y-2">
            {o.sent.map((m, i) => (
              <li key={i} className="space-y-1 rounded-md border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium">{sentKind(m.kind)}</span><span className="flex items-center gap-2 text-muted-foreground">{when(m.at)}{m.status && <StatusBadge status={m.status} />}</span></div>
                <p className="whitespace-pre-line">{m.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {o.lastReply && (
        <div className="space-y-1 rounded-md bg-muted p-2.5 text-sm">
          <div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium">Their last reply</span><span className="text-muted-foreground">{when(o.lastReply.at)}</span></div>
          <p className="whitespace-pre-line">{o.lastReply.text}</p>
          {o.lastReply.class && <div className="flex items-center gap-1.5 text-xs"><Sparkles className="size-3 text-fuchsia-500" /><span className="text-muted-foreground">AI read it as</span><ToneBadge>{o.lastReply.class}</ToneBadge></div>}
        </div>
      )}
    </section>
  );
}

function PersonSheet({ id, stages, outreachStates, allTags, onClose, onSaved }) {
  const [c, setC] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);
  const confirm = useConfirm();
  useEffect(() => {
    if (!id) return;
    setC(null);
    api.crm.contacts.get(id).then((x) => { if (!x) { toast.error("This person is no longer in the CRM"); onClose(); return; } setC(x); setForm({ stage: x.stage, tags: x.tags || [], notes: x.notes || "" }); }).catch((e) => toast.error(e.message));
  }, [id]);
  const dirty = c && form && (form.stage !== c.stage || form.notes !== (c.notes || "") || JSON.stringify(form.tags) !== JSON.stringify(c.tags || []));

  async function save() {
    setSaving(true);
    try {
      await api.crm.contacts.update(id, form);
      const fresh = await api.crm.contacts.get(id);
      setC(fresh);
      setForm({ stage: fresh.stage, tags: fresh.tags || [], notes: fresh.notes || "" });
      toast.success("Saved");
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  }

  async function outreachAction(action) {
    if (action === "dropped" && !(await confirm({ title: `Drop ${c.name || "this person"}?`, description: "No more outreach messages go to them. Messages already sent stay sent.", confirmLabel: "Drop", destructive: true }))) return;
    setBusy(action);
    try {
      await api.crm.contacts.setOutreachState(id, action);
      const fresh = await api.crm.contacts.get(id);
      // Keep a stage the person picked but has not saved; otherwise follow the stage the action moved to.
      setForm((f) => ({ ...f, stage: f.stage === c.stage ? fresh.stage : f.stage }));
      setC(fresh);
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  }

  const ev = c?.data?.evaluation;
  const ai = c?.data?.ai && typeof c.data.ai === "object" ? c.data.ai : null;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent onOpenAutoFocus={(e) => e.preventDefault()} className="w-full gap-0 sm:max-w-lg">
        {!c || !form ? <Loading /> : (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6 text-lg">{c.name || "Unnamed"}</SheetTitle>
              <SheetDescription>{c.headline}</SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                <StageBadge stage={c.stage} stages={stages} />
                {c.degree && <span>{c.degree}</span>}{c.location && <span>· {c.location}</span>}<span>· {c.accountName}</span>
                {c.profileUrl && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={c.profileUrl} target="_blank" rel="noreferrer">Profile<ExternalLink className="size-3" /></a>}
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-6 p-4">
                {c.outreach && <><OutreachSection c={c} states={outreachStates} busy={busy} onAction={outreachAction} /><Separator /></>}
                <section className="space-y-4">
                  <div className="space-y-1.5"><Label>Stage</Label><SimpleSelect value={form.stage} options={stages.map((s) => [s.id, s.label])} onChange={(v) => setForm({ ...form, stage: v })} /></div>
                  <div className="space-y-1.5"><Label>Tags</Label><TagEditor tags={form.tags} suggestions={allTags} onChange={(tags) => setForm({ ...form, tags })} /></div>
                  <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything worth remembering about this person" /></div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" disabled={!dirty} onClick={() => setForm({ stage: c.stage, tags: c.tags || [], notes: c.notes || "" })}>Reset</Button>
                    <Button disabled={!dirty || saving} onClick={save}>{saving && <Loader2 className="animate-spin" />}Save</Button>
                  </div>
                </section>
                {(ev || ai || c.data?.draft || c.data?.comment) && (
                  <>
                    <Separator />
                    <section className="space-y-2">
                      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="size-4 text-fuchsia-500" />AI evaluation</h3>
                      {ev && <div className="flex items-start gap-2 text-sm"><ToneBadge tone={ev.qualified ? "green" : "grey"}>{ev.score ?? "?"}</ToneBadge><span>{ev.reason}</span></div>}
                      {ai && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">{Object.entries(ai).map(([k, v]) => <Fragment2 key={k} k={k} v={v} />)}</dl>}
                      {c.data?.comment && <p className="text-sm"><span className="text-muted-foreground">Their comment: </span>“{c.data.comment}”</p>}
                      {c.data?.draft && <p className="rounded-md bg-muted p-2 text-sm"><span className="text-muted-foreground">Draft: </span>{c.data.draft}</p>}
                    </section>
                  </>
                )}
                <Separator />
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Timeline</h3>
                  <Timeline entries={c.timeline} />
                </section>
                {c.source && <p className="text-xs text-muted-foreground">First found by {c.source.workflowName || "a deleted workflow"} on {when(c.firstSeenAt)}.</p>}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fragment2({ k, v }) {
  return <><dt className="text-muted-foreground">{k}</dt><dd className="break-words">{String(v)}</dd></>;
}

export function People({ accounts, workflows }) {
  const [stages, setStages] = useState(DEFAULT_STAGES);
  const [outreachStates, setOutreachStates] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState({ accountId: "", stage: "", tag: "", foundBy: "", outreachState: "", search: "" });
  const [openId, setOpenId] = useState(null);
  const query = useMemo(() => Object.fromEntries(Object.entries(filter).filter(([, v]) => v)), [filter]);
  const { rows, total, error, load } = useCrmList(api.crm?.contacts?.list, query);

  useEffect(() => {
    api.crm?.stages?.().then((s) => s?.length && setStages(s)).catch(() => {});
    api.crm?.tags?.().then((t) => setAllTags(t || [])).catch(() => {});
    api.crm?.outreachStates?.().then((s) => setOutreachStates(s || [])).catch(() => {});
  }, []);
  useEffect(() => { const t = setTimeout(() => setFilter((f) => ({ ...f, search })), 250); return () => clearTimeout(t); }, [search]);

  const header = <PageHeader title="People" description="Everyone your workflows found, with the stage they are at. Stages move forward on their own as invites are accepted and messages answered; set qualified, meeting, won or lost by hand." />;
  if (error === "missing" || (error && /No handler/i.test(error))) return <Page>{header}<Unavailable what="People your workflows find" /></Page>;

  return (
    <Page>
      {header}
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative w-56"><Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 pl-8" placeholder="Search name, headline, link" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          {outreachStates.some((s) => s.id === "needs_you") && (
            <Toggle variant="outline" className="h-9 px-3 data-[state=on]:border-warning/50 data-[state=on]:bg-warning/12" data-testid="crm-needs-you" pressed={filter.outreachState === "needs_you"} onPressedChange={(on) => setFilter({ ...filter, outreachState: on ? "needs_you" : "" })}><BellRing />Needs you</Toggle>
          )}
          <SimpleSelect className="h-9 w-36" value={filter.stage} options={[["", "Any stage"], ...stages.map((s) => [s.id, s.label])]} onChange={(v) => setFilter({ ...filter, stage: v })} />
          <SimpleSelect className="h-9 w-32" value={filter.tag} options={[["", "Any tag"], ...allTags.map((t) => [t, t])]} onChange={(v) => setFilter({ ...filter, tag: v })} />
          {outreachStates.length > 0 && <SimpleSelect className="h-9 w-44" data-testid="crm-filter-outreach" value={filter.outreachState} options={[["", "Any outreach"], ...outreachStates.map((s) => [s.id, s.label])]} onChange={(v) => setFilter({ ...filter, outreachState: v })} />}
          {workflows.length > 0 && <SimpleSelect className="h-9 w-44" data-testid="crm-filter-found-by" value={filter.foundBy} options={[["", "Any workflow"], ...workflows.map((w) => [w.id, w.name])]} onChange={(v) => setFilter({ ...filter, foundBy: v })} />}
          {accounts.length > 1 && <SimpleSelect className="h-9 w-44" value={filter.accountId} options={[["", "All accounts"], ...accounts.map((a) => [a.id, a.name])]} onChange={(v) => setFilter({ ...filter, accountId: v })} />}
          <div className="flex-1" />
          {rows && <span className="text-xs text-muted-foreground">{total} {total === 1 ? "person" : "people"}</span>}
        </div>
        {error && <p className="p-4 text-sm text-destructive">Could not load people: {error}</p>}
        {!rows ? <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : rows.length === 0 ? <EmptyState icon={Users} title={Object.keys(query).length ? "Nobody matches these filters" : "No people yet"}>{Object.keys(query).length ? "Clear a filter to see more." : "People appear here after a run that finds or reads profiles."}</EmptyState>
          : (
            <Table>
              <TableHeader><TableRow><TableHead className="pl-4">Person</TableHead><TableHead>Stage</TableHead><TableHead>Outreach</TableHead><TableHead>Tags</TableHead><TableHead>Last activity</TableHead><TableHead className="pr-4">Found by</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id} data-testid="crm-row" className="cursor-pointer" onClick={() => setOpenId(c.id)}>
                    <TableCell className="max-w-md pl-4"><div className="font-medium">{c.name || c.profileUrl}</div><div className="truncate text-xs text-muted-foreground">{c.headline}</div></TableCell>
                    <TableCell><StageBadge stage={c.stage} stages={stages} /></TableCell>
                    <TableCell>
                      {c.outreach ? (
                        <div className="flex flex-col items-start gap-0.5">
                          <OutreachBadge outreach={c.outreach} states={outreachStates} />
                          {c.outreach.nextAction && <span className="text-xs text-muted-foreground" title={when(c.outreach.nextAction.at)}>next: {until(c.outreach.nextAction.at)}</span>}
                        </div>
                      ) : <span className="text-muted-foreground">–</span>}
                    </TableCell>
                    <TableCell><div className="flex max-w-56 flex-wrap gap-1">{(c.tags || []).map((t) => <Badge key={t} variant="secondary" className="font-normal">{t}</Badge>)}</div></TableCell>
                    <TableCell className="text-muted-foreground">{ago(c.lastActivityAt)}</TableCell>
                    <TableCell className="pr-4 text-muted-foreground">{c.source?.workflowName || "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        {rows && rows.length < total && <div className="border-t p-3 text-center"><Button variant="outline" size="sm" onClick={() => load(rows.length)}>Load more</Button></div>}
      </Card>
      <PersonSheet id={openId} stages={stages} outreachStates={outreachStates} allTags={allTags} onClose={() => setOpenId(null)} onSaved={() => { load(0); api.crm?.tags?.().then((t) => setAllTags(t || [])).catch(() => {}); }} />
    </Page>
  );
}

const ENGAGE = ["like", "comment", "repost"];

function PostSheet({ id, onClose }) {
  const [p, setP] = useState(null);
  useEffect(() => { if (id) { setP(null); api.crm.posts.get(id).then((x) => (x ? setP(x) : onClose())).catch((e) => toast.error(e.message)); } }, [id]);
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent onOpenAutoFocus={(e) => e.preventDefault()} className="w-full gap-0 sm:max-w-lg">
        {!p ? <Loading /> : (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6">{p.authorName || "Post"}</SheetTitle>
              <SheetDescription>First seen {when(p.firstSeenAt)}</SheetDescription>
              {p.postUrl && <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={p.postUrl} target="_blank" rel="noreferrer">Open post<ExternalLink className="size-3" /></a>}
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-6 p-4">
                <p className="text-sm whitespace-pre-line">{p.text}</p>
                <div className="flex flex-wrap gap-2">{ENGAGE.map((k) => p.engagement?.[k] && <span key={k} className="flex items-center gap-1.5 text-xs capitalize">{k}<StatusBadge status={p.engagement[k]} /></span>)}</div>
                <Separator />
                <section className="space-y-3"><h3 className="text-sm font-semibold">Timeline</h3><Timeline entries={p.timeline} /></section>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function Posts({ accounts }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState({ accountId: "", engaged: "", search: "" });
  const [openId, setOpenId] = useState(null);
  const query = useMemo(() => ({ ...(filter.accountId && { accountId: filter.accountId }), ...(filter.search && { search: filter.search }), ...(filter.engaged && { engaged: filter.engaged === "yes" }) }), [filter]);
  const { rows, total, error, load } = useCrmList(api.crm?.posts?.list, query);
  useEffect(() => { const t = setTimeout(() => setFilter((f) => ({ ...f, search })), 250); return () => clearTimeout(t); }, [search]);

  const header = <PageHeader title="Posts" description="Posts your workflows found, and whether each account liked, commented on or reposted them." />;
  if (error === "missing" || (error && /No handler/i.test(error))) return <Page>{header}<Unavailable what="Posts your workflows find" /></Page>;

  return (
    <Page>
      {header}
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative w-64"><Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 pl-8" placeholder="Search author or text" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <SimpleSelect className="h-9 w-44" value={filter.engaged} options={[["", "Engaged or not"], ["yes", "Engaged with"], ["no", "Not engaged"]]} onChange={(v) => setFilter({ ...filter, engaged: v })} />
          {accounts.length > 1 && <SimpleSelect className="h-9 w-44" value={filter.accountId} options={[["", "All accounts"], ...accounts.map((a) => [a.id, a.name])]} onChange={(v) => setFilter({ ...filter, accountId: v })} />}
          <div className="flex-1" />
          {rows && <span className="text-xs text-muted-foreground">{total} posts</span>}
        </div>
        {error && <p className="p-4 text-sm text-destructive">Could not load posts: {error}</p>}
        {!rows ? <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : rows.length === 0 ? <EmptyState icon={Newspaper} title="No posts yet">Posts appear here after a run that searches posts or reads the feed.</EmptyState>
          : (
            <Table>
              <TableHeader><TableRow><TableHead className="pl-4">Post</TableHead><TableHead>Engagement</TableHead><TableHead className="pr-4">Last activity</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} data-testid="crm-row" className="cursor-pointer" onClick={() => setOpenId(p.id)}>
                    <TableCell className="max-w-xl pl-4 whitespace-normal"><div className="font-medium">{p.authorName}</div><div className="line-clamp-2 text-xs text-muted-foreground">{p.text}</div></TableCell>
                    <TableCell><div className="flex flex-wrap gap-1">{ENGAGE.filter((k) => p.engagement?.[k]).map((k) => <StatusBadge key={k} status={p.engagement[k]} label={k} />)}{!ENGAGE.some((k) => p.engagement?.[k]) && <span className="text-xs text-muted-foreground">none</span>}</div></TableCell>
                    <TableCell className="pr-4 text-muted-foreground">{ago(p.lastActivityAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        {rows && rows.length < total && <div className="border-t p-3 text-center"><Button variant="outline" size="sm" onClick={() => load(rows.length)}>Load more</Button></div>}
      </Card>
      <PostSheet id={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}
