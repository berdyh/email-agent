import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { Toaster } from "sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Gmail Reader",
  description: "AI-powered Gmail analysis tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <QueryProvider>
            {children}
            <Toaster richColors position="bottom-right" />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
