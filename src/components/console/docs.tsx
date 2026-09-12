"use client";

import { BookOpen, ExternalLink, FileText, Radio, Scale } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Lucide no longer ships brand icons, so the GitHub mark is inlined. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Docs tab: where the code lives, how it is licensed, and where to read more.
 * Static content only - safe in viewer mode, no swarm state required.
 */

const REPO_URL = "https://github.com/simplefarmer69/laura-dashboard";
const REPO_BLOB = `${REPO_URL}/blob/main`;

const DOCUMENTS: Array<{ file: string; title: string; blurb: string }> = [
  {
    file: "README.md",
    title: "README",
    blurb: "What LAURA is, the agent roster, the grading loop, and how to run the swarm for your own project.",
  },
  {
    file: "DAIO.md",
    title: "DAIO.md",
    blurb: "The succession ladder to the StonkBrokers DAIO mandate at a $1B market cap, in engineering terms.",
  },
  {
    file: "FEEDS.md",
    title: "FEEDS.md",
    blurb: "The public read only GET endpoints under /api/feeds/* that mirror the console's live data.",
  },
  {
    file: "LICENSE",
    title: "LICENSE",
    blurb: "The MIT license text as it ships in the repository.",
  },
];

const FEED_ROUTES: Array<{ path: string; blurb: string }> = [
  { path: "/api/feeds/launcher", blurb: "Stonklauncher onchain buy tape" },
  { path: "/api/feeds/nft-buys", blurb: "StonkBroker NFT Seaport sales" },
  { path: "/api/feeds/tokens", blurb: "Robinhood Chain token marks" },
  { path: "/api/feeds/smartlp", blurb: "Smart LP vault fleet stats" },
  { path: "/api/feeds/fee-breakdown", blurb: "Protocol fee source breakdown" },
  { path: "/api/feeds/nft-trends", blurb: "NFT market trend signals" },
  { path: "/api/feeds/defillama", blurb: "TVL, fees and revenue series" },
  { path: "/api/feeds/polymarket", blurb: "Top prediction markets" },
  { path: "/api/feeds/espn", blurb: "Live scores for the Cafe Bar" },
];

const MIT_LICENSE = `MIT License

Copyright (c) 2026 SB (BVI) Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export function DocsPanel() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="sb-panel">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <GithubMark className="size-3.5 text-primary" /> Open source on GitHub
              </CardTitle>
              <Badge variant="outline" className="font-mono text-[10px] text-[var(--sb-green)]">
                MIT licensed
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The full swarm - agents, grader, launch logic, feeds and this console - lives in one public repository.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 border border-primary/40 bg-black/40 px-3 py-2.5 transition-colors hover:border-primary hover:bg-primary/10"
            >
              <GithubMark className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                simplefarmer69/laura-dashboard
              </span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
            </a>
            <div className="border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Clone it</p>
              <p className="mt-1 font-mono text-[11px] text-foreground/90">
                git clone {REPO_URL}.git
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              LAURA is a reusable swarm architecture: task and info management, goal tracking, and a roster of
              specialized agents graded daily against live metrics. The StonkBrokers deployment you are watching is
              the built in example. Swap the grader&apos;s metrics and the library&apos;s knowledge and the same swarm
              runs any goal driven operation. Contributions land through pull requests reviewed by the operator.
            </p>
          </CardContent>
        </Card>

        <Card className="sb-panel">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="size-3.5 text-[var(--sb-gold)]" /> Key documents
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">Read these in the repository for the full picture.</p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {DOCUMENTS.map((d) => (
                <li key={d.file}>
                  <a
                    href={`${REPO_BLOB}/${d.file}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-start gap-2.5 border border-border/60 bg-black/30 px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5"
                  >
                    <BookOpen className="mt-0.5 size-3.5 shrink-0 text-[var(--sb-gold)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-xs text-foreground group-hover:text-primary">
                        {d.title}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">{d.blurb}</span>
                    </span>
                    <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="sb-panel">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Radio className="size-3.5 text-[var(--sb-volt)]" /> Public data feeds
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Read only GET endpoints, no auth and no keys. Every route proxies public data with caching and a last good
            fallback. Full schemas in{" "}
            <a
              href={`${REPO_BLOB}/FEEDS.md`}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--sb-volt)] underline underline-offset-2 hover:text-[var(--sb-gold)]"
            >
              FEEDS.md
            </a>
            .
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {FEED_ROUTES.map((f) => (
              <a
                key={f.path}
                href={f.path}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-2 border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:border-[var(--sb-volt)]/60"
              >
                <span className="sb-chip font-mono text-[9px] text-[var(--sb-green)]">GET</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-foreground group-hover:text-[var(--sb-volt)]">
                    {f.path}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">{f.blurb}</span>
                </span>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="sb-panel">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Scale className="size-3.5 text-[var(--sb-green)]" /> MIT License
            </CardTitle>
            <a
              href={`${REPO_BLOB}/LICENSE`}
              target="_blank"
              rel="noreferrer"
              className="sb-chip font-mono text-[10px] text-[var(--sb-volt)] transition-colors hover:text-[var(--sb-gold)]"
            >
              LICENSE on GitHub
            </a>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Copyright (c) 2026 SB (BVI) Ltd. Use it, fork it, ship it. The notice below must ride along.
          </p>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto whitespace-pre-wrap border border-border/60 bg-black/40 p-4 font-mono text-[11px] leading-relaxed text-foreground/85">
            {MIT_LICENSE}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
