import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Boxes, KeyRound, Plug, ShieldCheck, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CopyButton } from "@/components/mcp/copy-button";
import { ecosystemMap } from "@/lib/mcp/ecosystem";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  mcpGroupedCatalogue,
  mcpPromptCatalogue,
  mcpResourceCatalogue,
  mcpToolCount,
} from "@/lib/mcp/server";
import { MCP_CLIENT_CONFIG, MCP_SITE, MCP_TAGLINE } from "@/lib/mcp/site";

/**
 * The public front door for the ecosystem MCP server: what it covers, how to
 * connect in under a minute, every tool, and the boundaries. Written to be
 * read by two audiences at once — a developer skimming for the endpoint, and
 * a crawler or agent building an index of available MCP servers. Hence the
 * JSON-LD block, the explicit endpoint in the copy, and the machine-readable
 * companions linked at the bottom.
 */

const TITLE = "StonkBrokers MCP server for AI agents · Robinhood Chain + Arbitrum One";
const DESCRIPTION =
  "Free read-only MCP (Model Context Protocol) server covering the whole StonkBrokers ecosystem: Stonk Launcher bonding curves on Robinhood Chain and Arbitrum One, live SafeLaunchLens quotes, tokenized-stock lanes, the ve(3,3) Stonk Exchange and Smart LP vaults, the Safety Deposit Box locker, ERC-6551 broker NFTs, the Nightshades survival game and protocol economics. Point any MCP client at https://laura.stonkbrokers.io/api/mcp.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "MCP server",
    "Model Context Protocol",
    "crypto MCP server",
    "DeFi MCP server",
    "AI agent crypto tools",
    "Robinhood Chain",
    "Arbitrum One",
    "StonkBrokers",
    "STONKBROKER",
    "Stonk Launcher",
    "bonding curve launchpad",
    "tokenized stocks on chain",
    "agent trading tools",
    "onchain agent",
    "autonomous trading agent",
    "Nightshades",
    "Smart LP vaults",
    "Safety Deposit Box",
    "ERC-6551",
    "LAURA agent swarm",
  ],
  alternates: { canonical: MCP_SITE.page },
  openGraph: {
    type: "website",
    url: MCP_SITE.page,
    siteName: "LAURA · StonkBrokers growth swarm",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/stonkbrokers-logo.png", width: 1200, height: 630, alt: "StonkBrokers ecosystem MCP server" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/stonkbrokers-logo.png"],
  },
  robots: { index: true, follow: true },
};

const CURL_LIST = `curl -s ${MCP_SITE.endpoint} \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

const CURL_QUOTE = `curl -s ${MCP_SITE.endpoint} \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"quote_launch",
        "arguments":{"lane":"weth","launchId":"276","side":"buy","amountIn":"0.05"}}}'`;

const CLAUDE_CODE = `claude mcp add --transport http stonkbrokers ${MCP_SITE.endpoint}`;

function CodeBlock({ code, copy = true }: { code: string; copy?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      {copy ? (
        <div className="flex items-center justify-end border-b bg-muted/60 px-2 py-1.5">
          <CopyButton value={code} />
        </div>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-relaxed text-foreground/90 sm:text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function McpPage() {
  const groups = mcpGroupedCatalogue();
  const resources = mcpResourceCatalogue();
  const prompts = mcpPromptCatalogue();
  const toolCount = mcpToolCount();
  const ecosystem = ecosystemMap();

  /* Structured data: an MCP server is an API, so WebAPI + SoftwareApplication
     is what indexers and agent directories look for, and the FAQ answers the
     questions an agent operator actually asks before connecting. */
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebAPI", "SoftwareApplication"],
        name: "StonkBrokers Ecosystem MCP Server",
        alternateName: MCP_SERVER_NAME,
        applicationCategory: "DeveloperApplication",
        softwareVersion: MCP_SERVER_VERSION,
        description: DESCRIPTION,
        url: MCP_SITE.page,
        documentation: MCP_SITE.page,
        provider: { "@type": "Organization", name: "LAURA · StonkBrokers growth swarm", url: MCP_SITE.origin },
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        potentialAction: {
          "@type": "ConsumeAction",
          target: { "@type": "EntryPoint", urlTemplate: MCP_SITE.endpoint, httpMethod: "POST", contentType: "application/json" },
        },
        featureList: groups.flatMap((g) => g.tools.map((t) => t.name)),
        keywords: (metadata.keywords as string[]).join(", "),
      },
      {
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is the StonkBrokers MCP server endpoint?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `POST ${MCP_SITE.endpoint}. Transport is Streamable HTTP, stateless JSON-RPC 2.0, protocol version ${MCP_PROTOCOL_VERSION}. No API key and no signup.`,
            },
          },
          {
            "@type": "Question",
            name: "What can an AI agent do with it?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `${toolCount} read-only tools: map the ecosystem, quote a live bonding-curve trade through SafeLaunchLensV2 on Robinhood Chain or Arbitrum One, resolve any token address, read pair depth and holder distribution, read protocol fees and revenue, read the Nightshades game state and the broker NFT market, and search LAURA's operating knowledge library.`,
            },
          },
          {
            "@type": "Question",
            name: "Can the server move funds?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "No. Every tool is read only. Nothing signs, spends, launches or posts. Agents bring their own wallet and submit their own transactions to the addresses the server reports.",
            },
          },
        ],
      },
    ],
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <header className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1.5">
            <Plug className="size-3.5" />
            Model Context Protocol
          </Badge>
          <Badge variant="outline">{toolCount} tools</Badge>
          <Badge variant="outline">read only</Badge>
          <Badge variant="outline">no API key</Badge>
        </div>

        <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          The StonkBrokers ecosystem, as one MCP server
        </h1>

        <p className="max-w-3xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
          Every protocol on Robinhood Chain and Arbitrum One that an autonomous agent can trade, quote, keep or build
          on, behind one standard interface. Bonding-curve launchpads with crypto and tokenized-stock quote lanes, live
          curve quotes from the pad&apos;s own lens, a ve(3,3) exchange with automated market-making vaults, a permanent
          liquidity locker, an ERC-6551 NFT collection with its own AMM, a VRF-resolved survival game, and the protocol
          economics underneath all of it.
        </p>

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Endpoint</p>
            <p className="truncate font-mono text-sm text-foreground sm:text-base">{MCP_SITE.endpoint}</p>
          </div>
          <CopyButton value={MCP_SITE.endpoint} label="Copy endpoint" />
        </div>
      </header>

      <Separator className="my-10" />

      <section aria-labelledby="connect" className="space-y-5">
        <div className="space-y-1.5">
          <h2 id="connect" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Terminal className="size-5 text-primary" />
            Connect in one line
          </h2>
          <p className="text-sm text-muted-foreground">
            Streamable HTTP, stateless JSON-RPC 2.0, protocol version {MCP_PROTOCOL_VERSION}. No key, no signup, CORS
            open.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Claude Code</CardTitle>
              <CardDescription>One command, then restart the session.</CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={CLAUDE_CODE} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Cursor, Claude Desktop, any MCP client</CardTitle>
              <CardDescription>Drop this into your MCP config file.</CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={MCP_CLIENT_CONFIG} />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">List the tools</CardTitle>
              <CardDescription>No client needed; it is plain HTTP.</CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={CURL_LIST} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Quote a real curve trade</CardTitle>
              <CardDescription>The pad&apos;s own lens answers, tax included.</CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={CURL_QUOTE} />
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator className="my-10" />

      <section aria-labelledby="tools" className="space-y-5">
        <div className="space-y-1.5">
          <h2 id="tools" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Boxes className="size-5 text-primary" />
            {toolCount} tools
          </h2>
          <p className="text-sm text-muted-foreground">
            Start with <span className="font-mono text-foreground">ecosystem_map</span>: it names every protocol, what
            you can do with it, and the trap each one sets for integrators.
          </p>
        </div>

        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.group} className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-sm font-semibold tracking-tight">{g.group}</h3>
                <p className="text-xs text-muted-foreground">{g.blurb}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {g.tools.map((t) => (
                  <div key={t.name} className="rounded-lg border bg-card/60 p-3">
                    <p className="font-mono text-[13px] font-medium text-primary">{t.name}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Separator className="my-10" />

      <section aria-labelledby="coverage" className="space-y-5">
        <div className="space-y-1.5">
          <h2 id="coverage" className="text-xl font-semibold tracking-tight">
            What it covers
          </h2>
          <p className="text-sm text-muted-foreground">
            The same list <span className="font-mono text-foreground">ecosystem_map</span> returns, with the opportunity
            each surface offers an agent.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {ecosystem.entries.map((e) => (
            <Card key={e.key}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm">{e.name}</CardTitle>
                  <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                    {e.category}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs leading-relaxed text-muted-foreground">{e.agentOpportunity}</p>
                <div className="flex flex-wrap gap-1">
                  {e.tools.map((t) => (
                    <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Separator className="my-10" />

      <section aria-labelledby="resources" className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle id="resources" className="text-sm">
              Resources
            </CardTitle>
            <CardDescription>Whole documents an agent can pin into context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {resources.map((r) => (
              <div key={r.uri}>
                <p className="font-mono text-xs text-primary">{r.uri}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{r.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Prompts</CardTitle>
            <CardDescription>Ready-made workflows that chain the tools correctly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {prompts.map((p) => (
              <div key={p.name}>
                <p className="font-mono text-xs text-primary">{p.name}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{p.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Separator className="my-10" />

      <section aria-labelledby="boundaries" className="space-y-5">
        <h2 id="boundaries" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ShieldCheck className="size-5 text-primary" />
          Boundaries
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              title: "Read only",
              body: "No tool signs, spends, launches, posts or edits state. Bring your own wallet and submit your own transactions to the addresses the server reports.",
            },
            {
              title: "No secrets, no key",
              body: "Every tool proxies data already public on the console and on chain. There is nothing to authenticate and nothing to leak.",
            },
            {
              title: "Quote, never guess",
              body: "Curve prices come from SafeLaunchLensV2, the pad's own lens. Reimplementing the decaying tax math is the most common way integrators get a fill they did not expect.",
            },
          ].map((b) => (
            <div key={b.title} className="rounded-lg border bg-card/60 p-4">
              <p className="text-sm font-medium">{b.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      <Separator className="my-10" />

      <section aria-labelledby="machine" className="space-y-4">
        <h2 id="machine" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <KeyRound className="size-5 text-primary" />
          Machine-readable companions
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            { href: "/.well-known/mcp.json", label: "/.well-known/mcp.json", note: "discovery card for MCP directories" },
            { href: "/llms.txt", label: "/llms.txt", note: "the short version, for agents" },
            { href: "/llms-full.txt", label: "/llms-full.txt", note: "every tool, address and rule in one file" },
            { href: "/api/agents/manifest", label: "/api/agents/manifest", note: "chain, contracts, feeds, rules as JSON" },
            { href: "/for-agents.md", label: "/for-agents.md", note: "plain-language onboarding" },
            { href: "/api/mcp", label: "/api/mcp", note: "GET returns the server card; POST speaks JSON-RPC" },
          ].map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="group flex items-center justify-between gap-3 rounded-lg border bg-card/60 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-card"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs text-primary">{l.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{l.note}</span>
                </span>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 space-y-2 border-t pt-6 text-xs text-muted-foreground">
        <p>{MCP_TAGLINE}</p>
        <p>
          Operated by{" "}
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            LAURA
          </Link>
          , the autonomous agent swarm growing the StonkBrokers ecosystem. Server {MCP_SERVER_NAME} v
          {MCP_SERVER_VERSION}.
        </p>
      </footer>
    </main>
  );
}
