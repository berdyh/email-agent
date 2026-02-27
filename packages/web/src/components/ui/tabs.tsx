"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const TabsContext = createContext<{ value: string; onChange: (v: string) => void }>({
  value: "",
  onChange: () => {},
});

export function Tabs({
  defaultValue,
  value: controlledValue,
  onValueChange,
  className,
  children,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const value = controlledValue ?? internalValue;
  const onChange = onValueChange ?? setInternalValue;

  return (
    <TabsContext.Provider value={{ value, onChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(TabsContext);
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
        ctx.value === value
          ? "bg-background text-foreground shadow-sm"
          : "hover:bg-background/50",
        className,
      )}
      onClick={() => ctx.onChange(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(TabsContext);
  if (ctx.value !== value) return null;
  return <div className={cn("mt-2", className)}>{children}</div>;
}
