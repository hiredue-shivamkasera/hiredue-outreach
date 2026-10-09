// The AI endpoint, model and key, the calendar link outreach sends, and whether the browser runs hidden.
import { useEffect, useState } from "react";
import { Bot, CalendarDays, Loader2, Monitor } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loading, Page, PageHeader, ToneBadge } from "@/components/common";

const api = window.outreach;

export default function Settings() {
  const [s, setS] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.settings.get().then(setS).catch((e) => toast.error(e.message)); }, []);
  if (!s) return <Loading />;

  async function save() {
    setSaving(true);
    try {
      await api.settings.set({ baseUrl: s.baseUrl, model: s.model, headless: s.headless, calendarLink: (s.calendarLink ?? "").trim(), apiKey });
      setApiKey("");
      setS(await api.settings.get());
      toast.success("Settings saved");
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  }

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Settings" description="The AI steps call any OpenAI-compatible endpoint. The default is the HireDue LiteLLM proxy; paste your LiteLLM key below." />
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Bot className="size-4" />AI model</CardTitle>
            <CardDescription>Used by AI prompt, AI qualify and AI write message.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="baseUrl">Endpoint</Label><Input id="baseUrl" value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="model">Model</Label><Input id="model" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="apiKey" className="flex items-center gap-2">API key {s.hasApiKey ? <ToneBadge tone="green">saved</ToneBadge> : <ToneBadge tone="red">not set</ToneBadge>}</Label>
              <Input id="apiKey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasApiKey ? "Leave blank to keep the saved key" : "sk-…"} />
              <p className="text-xs text-muted-foreground">Encrypted with the macOS keychain before it is stored.</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="size-4" />Outreach</CardTitle>
            <CardDescription>Used by the Outreach sequence step.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Label htmlFor="calendarLink">Calendar link</Label>
            <Input id="calendarLink" value={s.calendarLink ?? ""} onChange={(e) => setS({ ...s, calendarLink: e.target.value })} placeholder="https://cal.com/you/30min" />
            <p className="text-xs text-muted-foreground">Sent to people who reply that they are happy to talk, via <code className="rounded bg-muted px-1 font-mono">{"{{calendarLink}}"}</code> in outreach messages.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Monitor className="size-4" />Browser</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="headless">Run the browser hidden</Label>
                <p className="text-xs text-muted-foreground">Off: a window opens and you watch every run. Logging in always shows the window.</p>
              </div>
              <Switch id="headless" checked={!!s.headless} onCheckedChange={(v) => setS({ ...s, headless: v })} />
            </div>
          </CardContent>
          <CardFooter className="justify-end">
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}Save settings</Button>
          </CardFooter>
        </Card>
      </form>
    </Page>
  );
}
