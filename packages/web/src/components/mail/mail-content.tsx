"use client";

import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";

export function MailContent({
  bodyHtml,
  bodyText,
}: {
  bodyHtml: string;
  bodyText: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !bodyHtml) return;

    // Sanitize with DOMPurify before rendering — safe against XSS
    const sanitized = DOMPurify.sanitize(bodyHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });

    // Use shadow DOM to isolate email CSS from app styles
    let shadow = host.shadowRoot;
    if (!shadow) {
      shadow = host.attachShadow({ mode: "open" });
    }

    // Clear existing content
    while (shadow.firstChild) {
      shadow.removeChild(shadow.firstChild);
    }

    // Add styles
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      :host { display: block; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: inherit; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      pre { overflow-x: auto; }
    `;
    shadow.appendChild(styleEl);

    // Render sanitized content via DOM API
    const contentDiv = document.createElement("div");
    const sanitizedDoc = new DOMParser().parseFromString(sanitized, "text/html");
    while (sanitizedDoc.body.firstChild) {
      contentDiv.appendChild(sanitizedDoc.body.firstChild);
    }
    shadow.appendChild(contentDiv);
  }, [bodyHtml]);

  if (bodyHtml) {
    return <div ref={containerRef} className="min-h-[200px]" />;
  }

  return (
    <pre className="whitespace-pre-wrap text-sm leading-relaxed">
      {bodyText}
    </pre>
  );
}
