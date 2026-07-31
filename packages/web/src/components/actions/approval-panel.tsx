"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import {
  useApprovals,
  useApproveOperations,
  useRejectOperations,
  type ApprovalOperation,
} from "@/hooks/use-approvals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";

interface EmailDetail {
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  bodyText: string;
}

function operationLabel(op: ApprovalOperation): string {
  switch (op.type) {
    case "trash":
      return "Move to Trash";
    case "spam":
      return "Mark as Spam";
    case "markRead":
      return "Mark as Read";
    case "markUnread":
      return "Mark as Unread";
    case "removeLabels":
      return op.labelIds.length === 1 && op.labelIds[0] === "INBOX"
        ? "Archive"
        : `Remove labels: ${op.labelIds.join(", ")}`;
    case "addLabels":
      return `Add labels: ${op.labelIds.join(", ")}`;
    default:
      return op.type;
  }
}

function operationBadgeVariant(type: string): "destructive" | "secondary" {
  return type === "trash" || type === "spam" ? "destructive" : "secondary";
}

function formatDate(value: string): string {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? value : new Date(time).toLocaleString();
}

function EmailReviewDialog({
  operation,
  onClose,
}: {
  operation: ApprovalOperation | null;
  onClose: () => void;
}) {
  const { data: email, isLoading } = useQuery<EmailDetail>({
    queryKey: ["email", operation?.emailId, operation?.accountId],
    enabled: operation !== null,
    queryFn: async (): Promise<EmailDetail> => {
      const res = await fetch(
        `/api/gmail/${encodeURIComponent(operation!.emailId)}?accountId=${encodeURIComponent(operation!.accountId)}`,
      );
      if (!res.ok) throw new Error("Failed to load email");
      return res.json() as Promise<EmailDetail>;
    },
  });

  return (
    <Dialog
      open={operation !== null}
      onClose={onClose}
      title={
        operation && (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={operationBadgeVariant(operation.type)}>
                {operationLabel(operation)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                proposed by “{operation.actionName}”
              </span>
            </div>
            <h2 className="mt-2 truncate text-base font-semibold">
              {email?.subject ?? operation.email?.subject ?? "(no subject)"}
            </h2>
          </div>
        )
      }
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading email…
        </div>
      )}
      {!isLoading && !email && (
        <p className="text-sm text-muted-foreground">
          This email is not in the local database anymore.
        </p>
      )}
      {email && (
        <div className="space-y-3">
          <div className="space-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">From:</span> {email.from}
            </p>
            <p>
              <span className="text-muted-foreground">To:</span> {email.to}
            </p>
            <p>
              <span className="text-muted-foreground">Date:</span>{" "}
              {formatDate(email.date)}
            </p>
          </div>
          <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
            {email.bodyText || email.snippet}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ApprovalPanel() {
  const { data, isLoading } = useApprovals();
  const approve = useApproveOperations();
  const reject = useRejectOperations();
  // Track DEselected ids so freshly queued operations default to selected.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<ApprovalOperation | null>(null);

  const operations = useMemo(() => data?.operations ?? [], [data]);

  const batches = useMemo(() => {
    const byBatch = new Map<
      string,
      { actionName: string; createdAt: string; ops: ApprovalOperation[] }
    >();
    for (const op of operations) {
      const batch = byBatch.get(op.batchId);
      if (batch) {
        batch.ops.push(op);
      } else {
        byBatch.set(op.batchId, {
          actionName: op.actionName,
          createdAt: op.createdAt,
          ops: [op],
        });
      }
    }
    return [...byBatch.values()];
  }, [operations]);

  if (isLoading || operations.length === 0) return null;

  const selectedIds = operations
    .filter((op) => !deselected.has(op.id))
    .map((op) => op.id);
  const busy = approve.isPending || reject.isPending;

  function toggle(id: string, checked: boolean) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleApprove() {
    approve.mutate(
      { ids: selectedIds },
      {
        onSuccess: (result) => {
          if (result.failed > 0) {
            toast.error(
              `Applied ${result.applied} changes, ${result.failed} failed`,
            );
          } else {
            toast.success(`Applied ${result.applied} changes to Gmail`);
          }
          setDeselected(new Set());
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleReject(ids: string[]) {
    reject.mutate(
      { ids },
      {
        onSuccess: (result) => {
          toast.success(`Rejected ${result.rejected} pending changes`);
          setDeselected(new Set());
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Card className="mb-4 border-amber-500/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          <CardTitle className="text-base">
            Pending Gmail changes — approval required
          </CardTitle>
        </div>
        <CardDescription>
          Nothing is applied to Gmail until you approve it. Review the list,
          uncheck anything you want to keep, and click an email to read it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {batches.map((batch) => (
          <div key={batch.ops[0]!.batchId} className="rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">{batch.actionName}</span>
              <span className="text-xs text-muted-foreground">
                {formatDate(batch.createdAt)}
              </span>
            </div>
            <ul className="divide-y">
              {batch.ops.map((op) => (
                <li
                  key={op.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/30"
                  onClick={() => setReviewing(op)}
                >
                  <Checkbox
                    checked={!deselected.has(op.id)}
                    onCheckedChange={(checked) => toggle(op.id, checked)}
                    aria-label={`Select ${op.email?.subject ?? op.emailId}`}
                  />
                  <Badge
                    variant={operationBadgeVariant(op.type)}
                    className="shrink-0"
                  >
                    {operationLabel(op)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {op.email?.subject ?? `(not in local DB: ${op.emailId})`}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {op.email?.from}
                      {op.accountId && ` — ${op.accountId}`}
                    </p>
                  </div>
                  {op.email && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(op.email.date)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1"
            disabled={busy || selectedIds.length === 0}
            onClick={handleApprove}
          >
            {approve.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Apply selected ({selectedIds.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy || selectedIds.length === 0}
            onClick={() => handleReject(selectedIds)}
          >
            <X className="h-3.5 w-3.5" />
            Reject selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => handleReject(operations.map((op) => op.id))}
          >
            Reject all
          </Button>
        </div>
      </CardContent>

      <EmailReviewDialog
        operation={reviewing}
        onClose={() => setReviewing(null)}
      />
    </Card>
  );
}
