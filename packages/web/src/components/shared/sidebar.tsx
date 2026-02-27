"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, Zap, Network, Newspaper, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui-store";

const navItems = [
  { href: "/mail", label: "Inbox", icon: Inbox },
  { href: "/actions", label: "Actions", icon: Zap },
  { href: "/clusters", label: "Clusters", icon: Network },
  { href: "/digest", label: "Digest", icon: Newspaper },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-sidebar transition-all",
        collapsed ? "w-14" : "w-52",
      )}
    >
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
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
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
