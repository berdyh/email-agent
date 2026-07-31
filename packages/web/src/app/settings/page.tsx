"use client";

import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { useSettings, useUpdateSettings, type SanitizedSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useAccounts } from "@/hooks/use-accounts";
import { useEmailStore } from "@/store/email-store";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export default function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: accounts } = useAccounts();
  const queryClient = useQueryClient();
  const activeAccountEmail = useEmailStore((s) => s.activeAccountEmail);
  const setActiveAccount = useEmailStore((s) => s.setActiveAccount);
  const [local, setLocal] = useState<Partial<SanitizedSettings>>({});
  const [accountLoading, setAccountLoading] = useState(false);
  // Track whether the form has unsaved edits. Account operations invalidate the
  // ["settings"] query, so unconditionally copying every refetch into local
  // state would wipe in-progress edits. Only sync remote → local while pristine.
  const [dirty, setDirty] = useState(false);

  const editLocal = (next: Partial<SanitizedSettings>) => {
    setDirty(true);
    setLocal(next);
  };

  useEffect(() => {
    if (settings && !dirty) setLocal(settings);
  }, [settings, dirty]);

  const save = () => {
    // Accounts are managed by the dedicated /api/accounts endpoints. Never send
    // the stale local snapshot back, or removed accounts get resurrected.
    const payload = { ...local };
    delete payload["accounts"];
    updateSettings.mutate(payload, {
      onSuccess: () => {
        // Mark pristine so the post-save settings refetch resyncs remote → local.
        setDirty(false);
        toast.success("Settings saved");
      },
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
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
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
      // Removing the active account would leave activeAccountEmail pointing at a
      // deleted account (stale badge / list / action scoping). Reset to the
      // all-accounts view so scoping stays valid.
      if (activeAccountEmail === email) {
        setActiveAccount(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
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

  const agentMode = local.agentMode ?? "all-agents";
  const preferredAgent = local.preferredAgent ?? "claude";
  const prompts = (local.prompts ?? {}) as Partial<Record<"summary" | "digest", string>>;

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
                      onChange={(e) =>
                        editLocal({
                          ...local,
                          agentMode: e.target.value as SanitizedSettings["agentMode"],
                        })
                      }
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
                      onChange={(e) =>
                        editLocal({
                          ...local,
                          preferredAgent: e.target.value as SanitizedSettings["preferredAgent"],
                        })
                      }
                    >
                      <option value="claude">Claude</option>
                      <option value="claude-sdk">Claude SDK</option>
                      <option value="codex">Codex</option>
                      <option value="gemini">Gemini</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="direct-api">Direct API</option>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="prompts" className="space-y-4">
              {(["summary", "digest"] as const).map((key) => (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle className="text-base capitalize">{key} Prompt</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Textarea
                      rows={4}
                      value={prompts[key] ?? ""}
                      onChange={(e) =>
                        editLocal({
                          ...local,
                          prompts: {
                            ...prompts,
                            [key]: e.target.value,
                          } as SanitizedSettings["prompts"],
                        })
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

          </Tabs>
        </main>
      </div>
    </div>
  );
}
