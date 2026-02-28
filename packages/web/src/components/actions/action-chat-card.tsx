"use client";

import { useRef, useEffect, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { X, Send, Copy, Save, Loader2, Check } from "lucide-react";
import { useActionChatStore } from "@/store/action-chat-store";
import { useSendMessage, useSaveAction, deriveFilename } from "@/hooks/use-action-chat";
import { toast } from "sonner";

export function ActionChatCard() {
  const { mode, messages, isGenerating, extractedCode, editingAction, close } =
    useActionChatStore();
  const sendMessage = useSendMessage();
  const saveAction = useSaveAction();

  const [input, setInput] = useState("");
  const [filename, setFilename] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-derive filename from extracted code
  useEffect(() => {
    if (extractedCode && !filename) {
      setFilename(editingAction?.filename ?? deriveFilename(extractedCode));
    }
  }, [extractedCode, filename, editingAction]);

  // Auto-scroll to bottom on new messages or streaming content
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, isGenerating, lastMessage?.content]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;
    setInput("");
    sendMessage.mutate(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleCopy() {
    if (!extractedCode) return;
    await navigator.clipboard.writeText(extractedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSave() {
    if (!extractedCode || !filename) return;
    const finalFilename = filename.endsWith(".action.ts") ? filename : `${filename}.action.ts`;
    saveAction.mutate(
      { filename: finalFilename, content: extractedCode },
      {
        onSuccess: () => toast.success(`Action saved as ${finalFilename}`),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Card className="col-span-full border-2 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {mode === "create" ? "Create New Action" : `Edit: ${editingAction?.id ?? "Action"}`}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={close}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Chat Messages */}
        <ScrollArea ref={scrollRef} className="h-64 rounded-md border p-4">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {mode === "create"
                ? "Describe the email action you want to create..."
                : "Describe how you want to modify this action..."}
            </p>
          )}
          <div className="space-y-3">
            {messages.map((msg, i) => {
              const isStreaming =
                isGenerating &&
                msg.role === "assistant" &&
                i === messages.length - 1;
              const isThinking = isStreaming && !msg.content;

              // Don't render empty assistant message placeholder without streaming
              if (msg.role === "assistant" && !msg.content && !isStreaming) return null;

              return (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    {isThinking ? (
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Thinking...
                      </span>
                    ) : msg.role === "user" ? (
                      <span>{msg.content}</span>
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-headings:my-2 prose-code:before:content-none prose-code:after:content-none prose-code:rounded prose-code:bg-background/50 prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-pre:bg-background/50 prose-pre:text-xs">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </Markdown>
                        {isStreaming && (
                          <span className="inline-block w-1.5 h-4 ml-0.5 bg-foreground/70 animate-pulse align-text-bottom" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {/* Code Preview */}
        {extractedCode && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline">Code Preview</Badge>
              <div className="flex-1">
                <Input
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="action-name.action.ts"
                  className="h-7 text-xs"
                />
              </div>
              <Button variant="outline" size="sm" className="gap-1" onClick={handleCopy}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                size="sm"
                className="gap-1"
                onClick={handleSave}
                disabled={saveAction.isPending}
              >
                {saveAction.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                Save Action
              </Button>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 text-xs">
              {extractedCode}
            </pre>
          </div>
        )}

        {/* Input Area */}
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "create"
                ? "Describe what you want the action to do..."
                : "Describe what to change..."
            }
            className="min-h-[60px] resize-none"
            disabled={isGenerating}
          />
          <Button
            size="icon"
            className="h-[60px]"
            onClick={handleSend}
            disabled={!input.trim() || isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
