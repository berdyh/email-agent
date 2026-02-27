"use client";

import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { useActions, useRunAction } from "@/hooks/use-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

export default function ActionsPage() {
  const { data: actions, isLoading } = useActions();
  const runAction = useRunAction();

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold">Actions</h1>
            <p className="text-sm text-muted-foreground">
              Run AI-powered analysis on your emails
            </p>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading actions...
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {actions?.map((action) => (
              <Card key={action.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{action.name}</CardTitle>
                    {action.builtIn && (
                      <Badge variant="secondary">Built-in</Badge>
                    )}
                  </div>
                  <CardDescription>{action.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="sm"
                    className="gap-2"
                    disabled={runAction.isPending}
                    onClick={() => {
                      runAction.mutate(
                        { actionId: action.id },
                        {
                          onSuccess: (result) => {
                            if (result.status === "success") {
                              toast.success(`Action "${action.name}" completed`);
                            } else {
                              toast.error(result.error ?? "Action failed");
                            }
                          },
                          onError: (err) => toast.error(err.message),
                        },
                      );
                    }}
                  >
                    {runAction.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    Run
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
