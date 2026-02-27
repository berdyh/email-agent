"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";

interface Summary {
  overview: string;
  sections: Array<{
    text: string;
    citation: { startOffset: number; endOffset: number; previewText: string };
  }>;
  keyActions: string[];
}

export function MailSummary({
  emailId,
  bodyText,
}: {
  emailId: string;
  bodyText: string;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);

  const mutation = useMutation<Summary, Error>({
    mutationFn: async (): Promise<Summary> => {
      const res = await fetch("/api/analysis/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId }),
      });
      if (!res.ok) throw new Error("Failed to summarize");
      return res.json() as Promise<Summary>;
    },
    onSuccess: setSummary,
  });

  if (!summary) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="gap-2"
      >
        <Sparkles className="h-4 w-4" />
        {mutation.isPending ? "Summarizing..." : "AI Summary"}
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          AI Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{summary.overview}</p>

        {summary.keyActions.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm font-medium">Action Items:</h4>
            <ul className="list-disc pl-4 text-sm text-muted-foreground">
              {summary.keyActions.map((action, i) => (
                <li key={i}>{action}</li>
              ))}
            </ul>
          </div>
        )}

        {summary.sections.length > 0 && (
          <div className="space-y-2">
            {summary.sections.map((section, i) => (
              <div
                key={i}
                className="cursor-pointer rounded-md border p-2 text-sm hover:bg-accent"
                onClick={() => {
                  // Scroll to cited position in the email body (future enhancement)
                }}
              >
                {section.text}
                {section.citation?.previewText && (
                  <span className="mt-1 block text-xs italic text-muted-foreground">
                    &ldquo;{section.citation.previewText}&rdquo;
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
