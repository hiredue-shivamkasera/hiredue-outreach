// LinkedIn accounts: add, log in, rename, remove, and read what each one sent. Each account has its own browser profile folder, keyed by id.
import { useState } from "react";
import { Check, FolderOpen, History, Loader2, LogIn, Pencil, Plus, Trash2, UserCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Loading, Page, PageHeader, StatusBadge, ToneBadge, useConfirm } from "@/components/common";
import { actionLink, ago, when } from "@/lib/runs";

const api = window.outreach;

function AccountRow({ a, busy, onLogin, onHistory, onRemove, onRenamed }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  async function save() {
    try { await api.accounts.rename(a.id, name); setEditing(false); onRenamed(); } catch (e) { toast.error(e.message); }
  }
  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{a.name.slice(0, 1).toUpperCase()}</div>
      <div className="min-w-0 flex-1 space-y-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input autoFocus className="h-8 max-w-xs" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setEditing(false); setName(a.name); } }} data-testid="account-rename-input" />
            <Button size="icon-sm" onClick={save} disabled={!name.trim()} title="Save name" data-testid="account-rename-save"><Check /></Button>
            <Button size="icon-sm" variant="ghost" onClick={() => { setEditing(false); setName(a.name); }} title="Cancel"><X /></Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{a.name}</span>
            {api.accounts.rename && <Button variant="ghost" size="icon-xs" onClick={() => setEditing(true)} title="Rename" data-testid="account-rename"><Pencil /></Button>}
            {a.lastLoginAt ? <ToneBadge tone="green">Logged in</ToneBadge> : <ToneBadge tone="amber">Not logged in</ToneBadge>}
          </div>
        )}
        <div className="truncate text-xs text-muted-foreground">{a.profileUrl || "No LinkedIn profile seen yet"} · last login {ago(a.lastLoginAt)}</div>
        <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground/80" title="This account's own browser profile; renaming never moves it, so the login survives">
          <FolderOpen className="size-3 shrink-0" />{a.profileDir || `<app data>/accounts/${a.id}/browser`}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={onLogin} disabled={!!busy}>{busy === a.id ? <Loader2 className="animate-spin" /> : <LogIn />}{busy === a.id ? "Waiting for login…" : "Log in"}</Button>
        <Button variant="ghost" size="sm" onClick={onHistory}><History />History</Button>
        <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={onRemove} title="Remove account"><Trash2 /></Button>
      </div>
    </div>
  );
}

export default function Accounts({ accounts, refresh }) {
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(null);
  const [history, setHistory] = useState(null);

  async function add() {
    try { await api.accounts.create(name); setName(""); refresh(); } catch (e) { toast.error(e.message); }
  }

  async function login(id) {
    setBusy(id);
    try { await api.accounts.login(id); toast.success("Logged in"); } catch (e) { toast.error(e.message); }
    setBusy(null);
    refresh();
  }

  async function remove(a) {
    if (!(await confirm({ title: `Remove ${a.name}?`, description: "Its saved LinkedIn login and browser profile are deleted too. Workflows using it need another account.", confirmLabel: "Remove", destructive: true }))) return;
    try { await api.accounts.remove(a.id); refresh(); } catch (e) { toast.error(e.message); }
  }

  async function showHistory(a) {
    setHistory({ account: a, rows: null });
    try { setHistory({ account: a, rows: await api.accounts.actions(a.id) }); } catch (e) { toast.error(e.message); setHistory(null); }
  }

  return (
    <Page className="max-w-5xl">
      <PageHeader title="LinkedIn accounts" description="Each account gets its own browser profile. Press Log in, sign in to LinkedIn in the window that opens (two-factor included), and the window closes by itself once the feed loads. The app never sees the password." />
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">Add an account</CardTitle>
          <CardDescription>The name is only for you; it can be changed later without logging in again.</CardDescription>
          <form className="flex gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <Input className="max-w-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Account name, e.g. Shivam" />
            <Button type="submit"><Plus />Add account</Button>
          </form>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {accounts.length === 0 ? <EmptyState icon={UserCircle} title="No accounts yet">Add one above, then log in.</EmptyState>
            : accounts.map((a) => <AccountRow key={a.id + a.name} a={a} busy={busy} onLogin={() => login(a.id)} onHistory={() => showHistory(a)} onRemove={() => remove(a)} onRenamed={refresh} />)}
        </CardContent>
      </Card>

      <Sheet open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <SheetContent onOpenAutoFocus={(e) => e.preventDefault()} className="w-full gap-0 sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle>{history?.account.name}: what this account did</SheetTitle>
            <SheetDescription>Invites, messages, follows, reactions, comments and reposts, newest first. These count toward the daily caps.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            {!history?.rows ? <Loading /> : history.rows.length === 0 ? <EmptyState title="Nothing sent yet" /> : (
              <Table>
                <TableHeader><TableRow><TableHead className="pl-4">When</TableHead><TableHead>Action</TableHead><TableHead>Result</TableHead><TableHead className="pr-4">Who or what</TableHead></TableRow></TableHeader>
                <TableBody>
                  {history.rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="pl-4 text-xs text-muted-foreground">{when(r.at)}</TableCell>
                      <TableCell className="capitalize">{r.action}</TableCell>
                      <TableCell><StatusBadge status={r.status} />{r.detail && <div className="mt-1 text-xs text-muted-foreground">{r.detail}</div>}</TableCell>
                      <TableCell className="max-w-56 truncate pr-4"><a className="text-primary hover:underline" href={actionLink(r.target || r.profileUrl)} target="_blank" rel="noreferrer">{r.target || r.profileUrl}</a></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </Page>
  );
}
