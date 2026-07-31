"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(
        // The 16px box stays visually small, but `before:` widens the hit area
        // to ~40px so a near-miss tap doesn't land on the row behind it.
        "relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-colors",
        "before:absolute before:-inset-3 before:content-['']",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-primary text-primary-foreground" : "bg-background",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked);
      }}
    >
      {checked && <Check className="h-3 w-3" />}
    </button>
  );
}
