"use client";

import { useState } from "react";
import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import {
  useActions,
  useRunAction,
  useDeleteAction,
  useApplyOperations,
  type GmailOperationItem,
} from "@/hooks/use-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, Pencil, Trash2, Check, X } from "lucide-react";
import { toast } from "sonner";
import { ActionChatCard } from "@/components/actions/action-chat-card";
import { AppendActionCard } from "@/components/actions/append-action-card";
import { useActionChatStore } from "@/store/action-chat-store";

function formatOperationSummary(operations: GmailOperationItem[]): string {
  const counts: Record<string, number> = {};
  for (const op of operations) {
    counts[op.type] = (counts[op.type] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

export default function ActionsPage() {
  const { data: actions, isLoading } = useActions();
  const runAction = useRunAction();
  const deleteAction = useDeleteAction();
  const applyOps = useApplyOperations();
  const { isOpen, expandedCardId, openEdit } = useActionChatStore();
  const [pendingOps, setPendingOps] = useState<GmailOperationItem[] | null>(null);

  function handleDelete(filename: string, name: string) {
    if (!window.confirm(`Delete action "${name}"? This cannot be undone.`)) return;
    deleteAction.mutate(
      { filename },
      {
        onSuccess: () => toast.success(`Action "${name}" deleted`),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleApply() {
    if (!pendingOps) return;
    applyOps.mutate({ operations: pendingOps }, {
      onSuccess: (result) => {
        toast.success(`Applied ${result.applied} operations${result.failed ? `, ${result.failed} failed` : ""}`);
        setPendingOps(null);
      },
      onError: (err) => toast.error(err.message),
    });
  }

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

          {/* Pending operations confirmation */}
          {pendingOps && pendingOps.length > 0 && (
            <Card className="mb-4 border-amber-500/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Apply Gmail Changes?</CardTitle>
                <CardDescription>
                  {formatOperationSummary(pendingOps)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={applyOps.isPending}
                    onClick={handleApply}
                  >
                    {applyOps.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Apply
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={applyOps.isPending}
                    onClick={() => setPendingOps(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                    Skip
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading actions...
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {actions?.map((action) => {
              // If this card is expanded for editing, show the chat card instead
              if (isOpen && expandedCardId === action.id) {
                return <ActionChatCard key={action.id} />;
              }

              return (
                <Card key={action.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{action.name}</CardTitle>
                      <Badge variant={action.builtIn ? "secondary" : "outline"}>
                        {action.builtIn ? "Built-in" : "User"}
                      </Badge>
                    </div>
                    <CardDescription>{action.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2">
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
                                  if (result.applyResult) {
                                    toast.success(
                                      `"${action.name}" completed — auto-applied ${result.applyResult.applied} operations`,
                                    );
                                  } else {
                                    toast.success(`Action "${action.name}" completed`);
                                  }
                                  if (result.pendingOperations?.length) {
                                    setPendingOps(result.pendingOperations);
                                  }
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

                      {!action.builtIn && action.filename && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() =>
                              openEdit({ id: action.id, filename: action.filename! })
                            }
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 text-destructive hover:text-destructive"
                            disabled={deleteAction.isPending}
                            onClick={() => handleDelete(action.filename!, action.name)}
                          >
                            {deleteAction.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {/* Create card or append card */}
            {isOpen && expandedCardId === "__create__" ? (
              <ActionChatCard />
            ) : (
              <AppendActionCard />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
