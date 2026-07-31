"use client";

import { useState } from "react";
import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import {
  useActions,
  useRunAction,
  useDeleteAction,
  useApplyOperations,
  type ActionItem,
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
import { useEmailStore } from "@/store/email-store";

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
  const accountEmail = useEmailStore((s) => s.activeAccountEmail) ?? undefined;
  const [pendingOps, setPendingOps] = useState<GmailOperationItem[] | null>(null);
  // Track per-card in-flight runs/deletes by id. The shared mutation only exposes
  // the most recent variables and detaches per-invocation callbacks when a second
  // call starts, so we track progress locally and drive result handling inline via
  // mutateAsync (see handleRun / handleDelete) instead of per-call onSuccess/onSettled.
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [deletingFilenames, setDeletingFilenames] = useState<Set<string>>(new Set());

  async function handleRun(action: ActionItem) {
    setRunningIds((prev) => {
      const next = new Set(prev);
      next.add(action.id);
      return next;
    });
    try {
      const result = await runAction.mutateAsync({ actionId: action.id, accountEmail });
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(action.id);
        return next;
      });
    }
  }

  async function handleDelete(filename: string, name: string) {
    if (!window.confirm(`Delete action "${name}"? This cannot be undone.`)) return;
    setDeletingFilenames((prev) => {
      const next = new Set(prev);
      next.add(filename);
      return next;
    });
    try {
      await deleteAction.mutateAsync({ filename });
      toast.success(`Action "${name}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete action");
    } finally {
      setDeletingFilenames((prev) => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
    }
  }

  function handleApply() {
    if (!pendingOps) return;
    applyOps.mutate({ operations: pendingOps, accountEmail }, {
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

              const isRunning = runningIds.has(action.id);
              const isDeleting = action.filename
                ? deletingFilenames.has(action.filename)
                : false;

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
                        disabled={isRunning}
                        onClick={() => void handleRun(action)}
                      >
                        {isRunning ? (
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
                            disabled={isDeleting}
                            onClick={() => handleDelete(action.filename!, action.name)}
                          >
                            {isDeleting ? (
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
