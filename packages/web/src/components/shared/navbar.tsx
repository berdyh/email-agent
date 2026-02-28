"use client";

import { useTheme } from "next-themes";
import { Mail, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useAccounts } from "@/hooks/use-accounts";
import { useEmailStore } from "@/store/email-store";

export function Navbar() {
  const { theme, setTheme } = useTheme();
  const { data: accounts } = useAccounts();
  const activeAccountEmail = useEmailStore((s) => s.activeAccountEmail);
  const setActiveAccount = useEmailStore((s) => s.setActiveAccount);

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center border-b bg-background/95 px-4 backdrop-blur">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5" />
        <span className="text-lg font-semibold">Email Agent</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {accounts && accounts.length > 0 && (
          <Select
            value={activeAccountEmail ?? ""}
            onChange={(e) =>
              setActiveAccount(e.target.value || null)
            }
            className="h-8 w-48 text-xs"
            aria-label="Switch account"
          >
            <option value="">All Accounts</option>
            {accounts.map((account) => (
              <option key={account.email} value={account.email}>
                {account.email}{account.isDefault ? " (Default)" : ""}
              </option>
            ))}
          </Select>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </div>
    </header>
  );
}
