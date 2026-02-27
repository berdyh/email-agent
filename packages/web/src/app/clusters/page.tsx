"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Network } from "lucide-react";
import { toast } from "sonner";

interface Cluster {
  id: string;
  name: string;
  description: string;
  emailIds: string;
  method: string;
}

export default function ClustersPage() {
  const [clusters, setClusters] = useState<Cluster[]>([]);

  const mutation = useMutation<Cluster[], Error>({
    mutationFn: async (): Promise<Cluster[]> => {
      const res = await fetch("/api/analysis/cluster", { method: "POST" });
      if (!res.ok) throw new Error("Clustering failed");
      return res.json() as Promise<Cluster[]>;
    },
    onSuccess: (data) => {
      setClusters(data);
      toast.success(`Found ${data.length} clusters`);
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
              <h1 className="text-2xl font-semibold">Clusters</h1>
              <p className="text-sm text-muted-foreground">
                Group similar emails using AI embeddings
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
                <Network className="h-4 w-4" />
              )}
              Run Clustering
            </Button>
          </div>

          {clusters.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Network className="mb-4 h-12 w-12" />
              <p>No clusters yet. Run clustering to group your emails.</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {clusters.map((cluster) => {
                const emailIds = safeParseArray(cluster.emailIds);
                return (
                  <Card key={cluster.id}>
                    <CardHeader>
                      <CardTitle className="text-base">{cluster.name}</CardTitle>
                      <CardDescription>{cluster.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {emailIds.length} emails
                        </Badge>
                        <Badge variant="outline">{cluster.method}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function safeParseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
