"use client";
import Link from "next/link";
import { ArrowLeft, Hammer } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Header shared by the contracts index and each contract page. */
export function ContractsShell({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> LAURA
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <Hammer className="size-5 shrink-0 text-primary" />
            <h1 className="sb-title truncate text-lg font-bold tracking-tight">{title}</h1>
            {tag && (
              <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
                {tag}
              </Badge>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <Link href="/contracts" className="whitespace-nowrap text-muted-foreground hover:text-foreground">
              all contracts
            </Link>
            <Link href="/lab" className="whitespace-nowrap text-muted-foreground hover:text-foreground">
              The Lab
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
