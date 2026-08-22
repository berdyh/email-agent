"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Newspaper } from "lucide-react";
import { toast } from "sonner";

interface DigestEntry {
  sender: string;
  domain: string;
  emailCount: number;
  summary: string;
  highlights: string[];
  actionItems: string[];
}

interface Digest {
  date: string;
  overview: string;
  entries: DigestEntry[];
}

export default function DigestPage() {
  const [digest, setDigest] = useState<Digest | null>(null);

  const mutation = useMutation<Digest, Error>({
    mutationFn: async (): Promise<Digest> => {
      const res = await fetch("/api/analysis/digest", { method: "POST" });
      if (!res.ok) throw new Error("Digest generation failed");
      return res.json() as Promise<Digest>;
    },
    onSuccess: (data) => {
      setDigest(data);
      toast.success("Digest generated");
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Digest</h1>
              <p className="text-sm text-muted-foreground">
                AI-generated summaries of your subscription emails
              </p>
            </div>
            <Button
              className="gap-2"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Newspaper className="h-4 w-4" />
              )}
              Generate Digest
            </Button>
          </div>

          {!digest ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Newspaper className="mb-4 h-12 w-12" />
              <p>No digest yet. Generate one to summarize your subscriptions.</p>
            </div>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Overview</CardTitle>
                  <CardDescription>
                    {new Date(digest.date).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">{digest.overview}</p>
                </CardContent>
              </Card>

              <div className="grid gap-4 md:grid-cols-2">
                {digest.entries.map((entry, i) => (
                  <Card key={i}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{entry.sender}</CardTitle>
                        <Badge variant="secondary">
                          {entry.emailCount} emails
                        </Badge>
                      </div>
                      <CardDescription>{entry.domain}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm">{entry.summary}</p>
                      {entry.highlights.length > 0 && (
                        <div>
                          <h4 className="mb-1 text-sm font-medium">Highlights:</h4>
                          <ul className="list-disc pl-4 text-sm text-muted-foreground">
                            {entry.highlights.map((h, j) => (
                              <li key={j}>{h}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {entry.actionItems.length > 0 && (
                        <div>
                          <h4 className="mb-1 text-sm font-medium">Actions:</h4>
                          <ul className="list-disc pl-4 text-sm text-muted-foreground">
                            {entry.actionItems.map((a, j) => (
                              <li key={j}>{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
