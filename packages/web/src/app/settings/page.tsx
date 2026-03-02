"use client";

import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { useSettings, useUpdateSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useAccounts } from "@/hooks/use-accounts";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export default function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: accounts } = useAccounts();
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const [accountLoading, setAccountLoading] = useState(false);

  useEffect(() => {
    if (settings) setLocal(settings);
  }, [settings]);

  const save = () => {
    updateSettings.mutate(local, {
      onSuccess: () => toast.success("Settings saved"),
      onError: (err) => toast.error(err.message),
    });
  };

  const addAccount = async () => {
    setAccountLoading(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add" }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      const { authUrl } = (await res.json()) as { authUrl: string };
      window.location.href = authUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start OAuth flow");
      setAccountLoading(false);
    }
  };

  const setDefaultAccount = async (email: string) => {
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setDefault", email }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success(`${email} set as default`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set default");
    }
  };

  const removeAccount = async (email: string) => {
    if (!confirm(`Remove account ${email}? This will delete stored tokens.`)) return;
    try {
      const res = await fetch("/api/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success(`${email} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove account");
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col">
        <Navbar />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const agentMode = (local["agentMode"] as string) ?? "all-agents";
  const preferredAgent = (local["preferredAgent"] as string) ?? "claude";
  const prompts = (local["prompts"] ?? {}) as Record<string, string>;
  const notifications = (local["notifications"] ?? {}) as {
    desktop?: { enabled?: boolean; priorityOnly?: boolean };
  };
  const gmail = (local["gmail"] ?? {}) as { syncActions?: boolean };

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure Email Agent preferences
              </p>
            </div>
            <Button className="gap-2" onClick={save} disabled={updateSettings.isPending}>
              {updateSettings.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>

          <Tabs defaultValue="accounts">
            <TabsList>
              <TabsTrigger value="accounts">Accounts</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="prompts">Prompts</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="gmail">Gmail</TabsTrigger>
            </TabsList>

            <TabsContent value="accounts" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Gmail Accounts</CardTitle>
                  <CardDescription>
                    Manage connected Gmail accounts for email fetching
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {accounts && accounts.length > 0 ? (
                    accounts.map((account) => (
                      <div
                        key={account.email}
                        className="flex items-center justify-between rounded-md border px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{account.email}</span>
                          {account.isDefault && (
                            <Badge variant="secondary">Default</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {!account.isDefault && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void setDefaultAccount(account.email)}
                            >
                              Set Default
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeAccount(account.email)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No accounts configured. Add one to get started.
                    </p>
                  )}
                  <Button
                    className="mt-2 gap-2"
                    onClick={() => void addAccount()}
                    disabled={accountLoading}
                  >
                    {accountLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Add Account
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="agents" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Agent Mode</CardTitle>
                  <CardDescription>
                    How AI agents are selected for analysis tasks
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Mode</label>
                    <Select
                      value={agentMode}
                      onChange={(e) => setLocal({ ...local, agentMode: e.target.value })}
                    >
                      <option value="all-agents">All Agents (try each CLI)</option>
                      <option value="hybrid">Hybrid (CLI + API fallback)</option>
                      <option value="direct-api">Direct API only</option>
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Preferred Agent
                    </label>
                    <Select
                      value={preferredAgent}
                      onChange={(e) => setLocal({ ...local, preferredAgent: e.target.value })}
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="gemini">Gemini</option>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="prompts" className="space-y-4">
              {["summary", "priority", "clustering", "digest"].map((key) => (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle className="text-base capitalize">{key} Prompt</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Textarea
                      rows={4}
                      value={(prompts[key] as string) ?? ""}
                      onChange={(e) =>
                        setLocal({
                          ...local,
                          prompts: { ...prompts, [key]: e.target.value },
                        })
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="notifications" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Desktop Notifications</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm">Enabled</label>
                    <Switch
                      checked={notifications.desktop?.enabled ?? true}
                      onCheckedChange={(v) =>
                        setLocal({
                          ...local,
                          notifications: {
                            ...notifications,
                            desktop: { ...notifications.desktop, enabled: v },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm">High priority only</label>
                    <Switch
                      checked={notifications.desktop?.priorityOnly ?? true}
                      onCheckedChange={(v) =>
                        setLocal({
                          ...local,
                          notifications: {
                            ...notifications,
                            desktop: { ...notifications.desktop, priorityOnly: v },
                          },
                        })
                      }
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Webhooks</CardTitle>
                  <CardDescription>
                    Configure Slack, Discord, or custom webhook notifications
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Add webhook URLs in your settings.json file at ~/.email-agent/settings.json
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="gmail" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Gmail Sync</CardTitle>
                  <CardDescription>
                    Control how action results are applied to Gmail
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium">Auto-apply actions</label>
                      <p className="text-xs text-muted-foreground">
                        Automatically apply action recommendations (trash, spam, labels) to Gmail without confirmation
                      </p>
                    </div>
                    <Switch
                      checked={gmail.syncActions ?? false}
                      onCheckedChange={(v) =>
                        setLocal({
                          ...local,
                          gmail: { ...gmail, syncActions: v },
                        })
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
