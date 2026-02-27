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
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export default function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const [local, setLocal] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (settings) setLocal(settings);
  }, [settings]);

  const save = () => {
    updateSettings.mutate(local, {
      onSuccess: () => toast.success("Settings saved"),
      onError: (err) => toast.error(err.message),
    });
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
                Configure Gmail Reader preferences
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

          <Tabs defaultValue="agents">
            <TabsList>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="prompts">Prompts</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
            </TabsList>

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
                    Add webhook URLs in your settings.json file at ~/.gmail-reader/settings.json
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
