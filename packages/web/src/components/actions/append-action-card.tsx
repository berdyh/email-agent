"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";
import { useActionChatStore } from "@/store/action-chat-store";

export function AppendActionCard() {
  const { openCreate } = useActionChatStore();

  return (
    <Card
      className="cursor-pointer border-2 border-dashed border-muted-foreground/25 bg-muted/30 transition-colors hover:border-muted-foreground/50 hover:bg-muted/50"
      onClick={openCreate}
    >
      <CardContent className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 p-6">
        <div className="rounded-full border-2 border-dashed border-muted-foreground/30 p-2">
          <Plus className="h-6 w-6 text-muted-foreground/60" />
        </div>
        <span className="text-sm font-medium text-muted-foreground">Create New Action</span>
      </CardContent>
    </Card>
  );
}
