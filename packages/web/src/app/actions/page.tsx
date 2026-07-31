"use client";

import { useState } from "react";
import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import {
  useActions,
  useRunAction,
  useDeleteAction,
  type ActionItem,
} from "@/hooks/use-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ActionChatCard } from "@/components/actions/action-chat-card";
import { AppendActionCard } from "@/components/actions/append-action-card";
import { ApprovalPanel } from "@/components/actions/approval-panel";
import { useActionChatStore } from "@/store/action-chat-store";
import { useEmailStore } from "@/store/email-store";

export default function ActionsPage() {
  const { data: actions, isLoading } = useActions();
  const runAction = useRunAction();
  const deleteAction = useDeleteAction();
  const { isOpen, expandedCardId, openEdit } = useActionChatStore();
  const accountEmail = useEmailStore((s) => s.activeAccountEmail) ?? undefined;
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
        if (result.pendingOperations?.length) {
          toast.success(
            `"${action.name}" completed — ${result.pendingOperations.length} Gmail changes await your approval`,
          );
        } else {
          toast.success(`Action "${action.name}" completed`);
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

          {/* Queued Gmail changes awaiting the user's approval */}
          <ApprovalPanel />

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
