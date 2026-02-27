"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

type Step = "check" | "login" | "project" | "done";

export default function SetupPage() {
  const [step, setStep] = useState<Step>("check");
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(false);

  const steps: { id: Step; label: string }[] = [
    { id: "check", label: "Check gcloud CLI" },
    { id: "login", label: "Authenticate" },
    { id: "project", label: "Set project" },
    { id: "done", label: "Complete" },
  ];

  const currentIdx = steps.findIndex((s) => s.id === step);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Email Agent Setup</CardTitle>
          <CardDescription>
            Configure Google Cloud access for Gmail integration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Progress */}
          <div className="flex gap-4">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                {i < currentIdx ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : i === currentIdx ? (
                  <Circle className="h-4 w-4 text-primary" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className={i <= currentIdx ? "text-foreground" : "text-muted-foreground"}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>

          {/* Step content */}
          {step === "check" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                First, let&apos;s verify that the gcloud CLI is installed and accessible.
              </p>
              <Button onClick={() => setStep("login")}>
                Continue
              </Button>
            </div>
          )}

          {step === "login" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Run the following in your terminal to authenticate:
              </p>
              <code className="block rounded bg-muted p-3 text-sm">
                gcloud auth application-default login --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/pubsub
              </code>
              <Button onClick={() => setStep("project")}>
                I&apos;ve authenticated
              </Button>
            </div>
          )}

          {step === "project" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Enter your Google Cloud project ID:
              </p>
              <Input
                placeholder="my-project-id"
                value={projectId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectId(e.target.value)}
              />
              <Button
                disabled={!projectId || loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    await fetch("/api/settings", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        gcp: { projectId, pubsubTopic: "email-agent-notifications", pubsubSubscription: "email-agent-sub" },
                      }),
                    });
                    setStep("done");
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save &amp; Continue
              </Button>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-3">
              <p className="text-sm text-green-600">
                Setup complete! You can now start using Email Agent.
              </p>
              <Button onClick={() => { globalThis.location.href = "/mail"; }}>
                Go to Inbox
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
