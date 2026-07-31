"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, Zap, Network, Newspaper, Settings } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useEmailStore } from "@/store/email-store";

const navItems = [
  { href: "/mail", label: "Inbox", icon: Inbox },
  { href: "/actions", label: "Actions", icon: Zap },
  { href: "/clusters", label: "Clusters", icon: Network },
  { href: "/digest", label: "Digest", icon: Newspaper },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const accountEmail = useEmailStore((s) => s.activeAccountEmail);

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["unreadCount", accountEmail ?? null],
    queryFn: async () => {
      const url = accountEmail
        ? `/api/gmail/unread-count?accountId=${encodeURIComponent(accountEmail)}`
        : "/api/gmail/unread-count";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch unread count");
      return res.json() as Promise<{ count: number }>;
    },
    refetchInterval: 60_000,
  });

  const unreadCount = unreadData?.count ?? 0;

  const { data: approvalsData } = useQuery<{ pendingCount: number }>({
    queryKey: ["approvals", "count"],
    queryFn: async () => {
      const res = await fetch("/api/approvals");
      if (!res.ok) throw new Error("Failed to fetch pending approvals");
      return res.json() as Promise<{ pendingCount: number }>;
    },
    refetchInterval: 60_000,
  });

  const pendingApprovals = approvalsData?.pendingCount ?? 0;

  return (
    <aside className="flex w-52 flex-col border-r bg-sidebar transition-all">
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          const badgeCount =
            item.href === "/mail"
              ? unreadCount
              : item.href === "/actions"
                ? pendingApprovals
                : 0;
          const showBadge = badgeCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {showBadge && (
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                    item.href === "/actions"
                      ? "bg-amber-500 text-black"
                      : "bg-primary text-primary-foreground",
                  )}
                >
                  {badgeCount > 99 ? "99+" : badgeCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
