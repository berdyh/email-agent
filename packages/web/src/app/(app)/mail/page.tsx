"use client";

import { Navbar } from "@/components/shared/navbar";
import { Sidebar } from "@/components/shared/sidebar";
import { MailLayout } from "@/components/mail/mail-layout";

export default function MailPage() {
  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <MailLayout />
        </main>
      </div>
    </div>
  );
}
