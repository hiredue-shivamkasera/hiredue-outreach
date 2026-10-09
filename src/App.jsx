// The app shell: sidebar navigation, header with the theme toggle, and which screen is showing. Screens own their own data loading.
import { useCallback, useEffect, useMemo, useState } from "react";
import { History, LayoutDashboard, Monitor, Moon, Newspaper, Plus, Settings as SettingsIcon, Sun, UserCircle, Users, Workflow } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarRail, SidebarTrigger } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { ConfirmProvider, Loading } from "@/components/common";
import { useTheme } from "@/lib/theme";
import Dashboard from "@/pages/Dashboard";
import { WorkflowList } from "@/pages/Workflows";
import WorkflowPage from "@/pages/WorkflowPage";
import { RunHistory, RunDetail } from "@/pages/Runs";
import { People, Posts } from "@/pages/Crm";
import Accounts from "@/pages/Accounts";
import Settings from "@/pages/Settings";

const api = window.outreach;

const NAV = [
  { kind: "dashboard", label: "Dashboard", icon: LayoutDashboard, testid: "nav-dashboard" },
];
const CRM_NAV = [
  { kind: "people", label: "People", icon: Users, testid: "nav-crm-people" },
  { kind: "posts", label: "Posts", icon: Newspaper, testid: "nav-crm-posts" },
];
const ACTIVITY_NAV = [
  { kind: "runs", label: "Run history", icon: History, testid: "nav-runs", match: ["runs", "run"] },
];
const SETUP_NAV = [
  { kind: "accounts", label: "Accounts", icon: UserCircle, testid: "nav-accounts" },
  { kind: "settings", label: "Settings", icon: SettingsIcon, testid: "nav-settings" },
];

function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const Icon = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" data-testid="theme-toggle" title="Theme"><Icon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light" data-testid="theme-light"><Sun />Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" data-testid="theme-dark"><Moon />Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" data-testid="theme-system"><Monitor />System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavItems({ items, view, go }) {
  return items.map((n) => (
    <SidebarMenuItem key={n.kind}>
      <SidebarMenuButton data-testid={n.testid} tooltip={n.label} isActive={(n.match || [n.kind]).includes(view.kind)} onClick={() => go({ kind: n.kind })}>
        <n.icon /><span>{n.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  ));
}

const TITLES = { dashboard: "Dashboard", workflows: "Workflows", workflow: "Workflow", runs: "Run history", run: "Run", people: "People", posts: "Posts", accounts: "Accounts", settings: "Settings" };

export default function App() {
  const [view, setView] = useState({ kind: "dashboard" });
  const [workflows, setWorkflows] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [accounts, setAccounts] = useState([]);

  const refresh = useCallback(async () => {
    const [w, a] = await Promise.all([api.workflows.list(), api.accounts.list()]);
    setWorkflows(w);
    setAccounts(a);
    return w;
  }, []);

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => toast.error(`Could not load the step catalog: ${e.message}`));
    refresh().catch((e) => toast.error(e.message));
  }, [refresh]);

  const defs = useMemo(() => Object.fromEntries((catalog || []).map((d) => [d.type, d])), [catalog]);
  const go = useCallback((v) => { setView(v); document.getElementById("main-scroll")?.scrollTo(0, 0); }, []);

  async function newWorkflow() {
    try {
      const wf = await api.workflows.save({ name: "Untitled workflow", accountId: accounts[0]?.id || null, nodes: [{ id: "start", type: "start", position: { x: 60, y: 120 }, params: {} }], edges: [] });
      await refresh();
      go({ kind: "workflow", id: wf.id, edit: true });
    } catch (e) { toast.error(e.message); }
  }

  const ctx = { catalog: catalog || [], defs, workflows, accounts, refresh, go };
  const wfName = view.kind === "workflow" ? workflows.find((w) => w.id === view.id)?.name : null;

  let page;
  if (!catalog) page = <Loading />;
  else if (view.kind === "dashboard") page = <Dashboard {...ctx} />;
  else if (view.kind === "workflows") page = <WorkflowList {...ctx} onNew={newWorkflow} />;
  else if (view.kind === "workflow") page = <WorkflowPage key={view.id} {...ctx} workflowId={view.id} startEditing={!!view.edit} initialRunId={view.runId} />;
  else if (view.kind === "runs") page = <RunHistory key={view.workflowId || "all"} {...ctx} workflowId={view.workflowId} />;
  else if (view.kind === "run") page = <RunDetail key={view.runId} {...ctx} runId={view.runId} onBack={() => go(view.from || { kind: "runs" })} />;
  else if (view.kind === "people") page = <People {...ctx} />;
  else if (view.kind === "posts") page = <Posts {...ctx} />;
  else if (view.kind === "accounts") page = <Accounts {...ctx} />;
  else if (view.kind === "settings") page = <Settings />;

  return (
    <TooltipProvider delayDuration={300}>
      <ConfirmProvider>
        <SidebarProvider className="h-svh overflow-hidden">
          <Sidebar collapsible="icon" variant="sidebar">
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="lg" className="pointer-events-none">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Workflow className="size-4" /></div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-semibold">HireDue Outreach</span>
                      <span className="truncate text-xs text-muted-foreground">LinkedIn workflows</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <NavItems items={NAV} view={view} go={go} />
                    <SidebarMenuItem>
                      <SidebarMenuButton data-testid="nav-workflows" tooltip="Workflows" isActive={view.kind === "workflows"} onClick={() => go({ kind: "workflows" })}><Workflow /><span>Workflows</span></SidebarMenuButton>
                      <SidebarMenuAction onClick={newWorkflow} title="New workflow"><Plus /></SidebarMenuAction>
                      {workflows.length > 0 && (
                        <SidebarMenuSub>
                          {workflows.map((w) => (
                            <SidebarMenuSubItem key={w.id}>
                              <SidebarMenuSubButton isActive={view.kind === "workflow" && view.id === w.id} onClick={() => go({ kind: "workflow", id: w.id })} className="cursor-pointer">
                                <span className="truncate">{w.name}</span>
                                {w.active && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success" title="Active" />}
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>CRM</SidebarGroupLabel>
                <SidebarGroupContent><SidebarMenu><NavItems items={CRM_NAV} view={view} go={go} /></SidebarMenu></SidebarGroupContent>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>Activity</SidebarGroupLabel>
                <SidebarGroupContent><SidebarMenu><NavItems items={ACTIVITY_NAV} view={view} go={go} /></SidebarMenu></SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <SidebarMenu><NavItems items={SETUP_NAV} view={view} go={go} /></SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>
          <SidebarInset className="min-h-0 overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
              <nav className="flex min-w-0 items-center gap-1.5 text-sm">
                {view.kind === "workflow" && <><button className="text-muted-foreground hover:text-foreground" onClick={() => go({ kind: "workflows" })}>Workflows</button><span className="text-muted-foreground/50">/</span></>}
                {view.kind === "run" && <><button className="text-muted-foreground hover:text-foreground" onClick={() => go(view.from || { kind: "runs" })}>Run history</button><span className="text-muted-foreground/50">/</span></>}
                <span className="truncate font-medium">{wfName || TITLES[view.kind]}</span>
              </nav>
              <div className="flex-1" />
              <ThemeToggle />
            </header>
            <div id="main-scroll" className="min-h-0 flex-1 overflow-auto">{page}</div>
          </SidebarInset>
        </SidebarProvider>
        <Toaster richColors closeButton position="bottom-right" />
      </ConfirmProvider>
    </TooltipProvider>
  );
}
