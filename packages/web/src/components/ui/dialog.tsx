"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    // Restore focus to whatever opened the dialog once it closes, so keyboard
    // users land back where they were instead of at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const focusableSelector =
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      // aria-modal tells assistive tech the rest of the page does not exist,
      // so Tab must not be able to walk out of the panel.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((el) => el.offsetParent !== null || el === panel);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : ariaLabel}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "relative z-50 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg focus:outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b p-4">
          <div id={titleId} className="min-w-0 flex-1">
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="-m-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
