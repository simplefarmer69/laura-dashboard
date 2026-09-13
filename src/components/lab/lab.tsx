"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, FlaskConical, LogOut, RefreshCw, Wallet } from "lucide-react";
import type { Address } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MARKET_ADDRESS, explorerContract, type Listing } from "@/lib/lab/contracts";
import { discoverRegistryAddress, fetchListings, fetchMetadata, fetchTargetInfo, fetchTokenInfo, type MetadataRecord, type TokenInfo } from "@/lib/lab/reads";
import { useWallet } from "@/lib/lab/wallet";
import { ListingCard } from "@/components/lab/listing-card";
import { ListingDialog } from "@/components/lab/listing-dialog";
import { SellWizard } from "@/components/lab/sell-wizard";
import { HowItWorks } from "@/components/lab/how-it-works";
import { fmtUnits, sameAddress, short } from "@/components/lab/format";

type Filter = "all" | "sale" | "sold" | "closed";

const GUIDE = "https://github.com/simplefarmer69/laura-dashboard/blob/main/docs/THE-LAB.md";

export function Lab() {
  const wallet = useWallet();
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [meta, setMeta] = useState<Map<number, MetadataRecord>>(new Map());
  const [tokens, setTokens] = useState<Map<string, TokenInfo>>(new Map());
  const [verified, setVerified] = useState<Map<string, boolean | null>>(new Map());
  const [registry, setRegistry] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("browse");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ls, reg] = await Promise.all([fetchListings(), registry ? Promise.resolve(registry) : discoverRegistryAddress()]);
      setListings(ls);
      if (reg && !registry) setRegistry(reg);
      const maxId = ls.length > 0 ? Math.max(...ls.map((l) => l.id)) : 0;
      if (reg) {
        try {
          setMeta(await fetchMetadata(reg, maxId));
        } catch {
          /* registry unreachable: on-chain listing data still renders */
        }
      }
      const tokenAddrs = [...new Set(ls.map((l) => l.payToken.toLowerCase()))];
      const infos = await Promise.all(tokenAddrs.map((a) => fetchTokenInfo(a as Address).catch(() => null)));
      setTokens((prev) => {
        const next = new Map(prev);
        infos.forEach((t) => t && next.set(t.address.toLowerCase(), t));
        return next;
      });
      const targets = [...new Set(ls.filter((l) => l.status === "listed").map((l) => l.target.toLowerCase()))].slice(0, 24);
      void Promise.all(
        targets.map(async (t) => {
          const info = await fetchTargetInfo(t as Address).catch(() => null);
          setVerified((prev) => new Map(prev).set(t, info ? info.verified : null));
        }),
      );
    } catch (err) {
      setError(`Could not read the market from Robinhood Chain: ${String((err as { shortMessage?: string })?.shortMessage ?? err).slice(0, 160)}`);
    } finally {
      setLoading(false);
    }
  }, [registry]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 45_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listings ?? []).filter((l) => {
      if (filter === "sale" && !(l.status === "listed")) return false;
      if (filter === "sold" && !(l.status === "sold" || l.status === "delivered")) return false;
      if (filter === "closed" && !(l.status === "cancelled" || l.status === "refunded")) return false;
      if (!q) return true;
      const m = meta.get(l.id)?.meta;
      return (
        l.target.toLowerCase().includes(q) ||
        l.seller.toLowerCase().includes(q) ||
        l.description.toLowerCase().includes(q) ||
        String(l.id) === q ||
        Boolean(m && (m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q))))
      );
    });
  }, [listings, filter, query, meta]);

  const mine = useMemo(
    () => (listings ?? []).filter((l) => wallet.account && (sameAddress(l.seller, wallet.account) || sameAddress(l.buyer, wallet.account))),
    [listings, wallet.account],
  );

  const stats = useMemo(() => {
    const ls = listings ?? [];
    const forSale = ls.filter((l) => l.status === "listed" && l.escrowed).length;
    const sold = ls.filter((l) => l.status === "sold" || l.status === "delivered").length;
    const volume = new Map<string, bigint>();
    for (const l of ls) {
      if (l.status === "sold" || l.status === "delivered") volume.set(l.payToken.toLowerCase(), (volume.get(l.payToken.toLowerCase()) ?? 0n) + l.paid);
    }
    return { total: ls.length, forSale, sold, volume };
  }, [listings]);

  const openListing = openId === null ? null : (listings ?? []).find((l) => l.id === openId) ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> LAURA
          </Link>
          <div className="flex items-center gap-2">
            <FlaskConical className="size-5 text-primary" />
            <h1 className="sb-title whitespace-nowrap text-lg font-bold tracking-tight">The Lab</h1>
            <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
              ownership market · Robinhood Chain
            </Badge>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <WalletButton wallet={wallet} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        <section className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <Card className="sb-panel">
            <CardHeader>
              <CardTitle className="text-base">Buy and sell smart contracts on Robinhood Chain</CardTitle>
              <CardDescription className="text-xs leading-relaxed">
                Any contract with <code>owner()</code> and <code>transferOwnership()</code> (an NFT collection, a token, a vault, a game, a tool) can be listed here in any token. The market escrows
                the ownership, the buyer pays, anyone executes the handover, the seller claims the funds. 1% protocol fee, no owner, no admin, no pause. Built, audited and deployed by
                LAURA&apos;s swarm; the storefront data lives on-chain too, so anyone can host this frontend.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-xs">
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorerContract(MARKET_ADDRESS)} target="_blank" rel="noreferrer">
                market {short(MARKET_ADDRESS, 6)} <ExternalLink className="size-3" />
              </a>
              {registry ? (
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorerContract(registry)} target="_blank" rel="noreferrer">
                  registry {short(registry, 6)} <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">registry: deploying</span>
              )}
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={GUIDE} target="_blank" rel="noreferrer">
                guide and source <ExternalLink className="size-3" />
              </a>
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="listings" value={listings ? String(stats.total) : "…"} />
            <Stat label="for sale now" value={listings ? String(stats.forSale) : "…"} tone="green" />
            <Stat label="sold" value={listings ? String(stats.sold) : "…"} />
            <Stat
              label="volume"
              value={
                listings
                  ? stats.volume.size === 0
                    ? "0"
                    : [...stats.volume.entries()]
                        .map(([addr, v]) => {
                          const t = tokens.get(addr);
                          return t ? `${fmtUnits(v, t.decimals, 3)} ${t.symbol}` : "…";
                        })
                        .join(" · ")
                  : "…"
              }
            />
          </div>
        </section>

        {error && (
          <div className="rounded-md border border-[var(--sb-neg)]/40 bg-[var(--sb-neg)]/10 p-3 text-xs">
            {error}{" "}
            <button type="button" className="underline" onClick={() => void refresh()}>
              retry
            </button>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="sell">Sell a contract</TabsTrigger>
            <TabsTrigger value="mine">My activity{mine.length > 0 ? ` (${mine.length})` : ""}</TabsTrigger>
            <TabsTrigger value="how">How it works</TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["all", "All"],
                  ["sale", "For sale"],
                  ["sold", "Sold"],
                  ["closed", "Closed"],
                ] as Array<[Filter, string]>
              ).map(([k, label]) => (
                <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} onClick={() => setFilter(k)}>
                  {label}
                </Button>
              ))}
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search name, tag, address, id" className="ml-auto h-8 w-full text-xs sm:w-64" />
            </div>
            {listings === null && !error && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-64 animate-pulse rounded-lg border border-border/60 bg-black/30" />
                ))}
              </div>
            )}
            {listings !== null && shown.length === 0 && (
              <Card>
                <CardContent className="space-y-2 py-10 text-center text-sm text-muted-foreground">
                  {listings.length === 0 ? (
                    <>
                      <p>No listings yet. The market went live on 13 Sep 2026; the first contract sold here will be the first contract ever sold on Robinhood Chain.</p>
                      <Button size="sm" onClick={() => setTab("sell")}>
                        List the first one
                      </Button>
                    </>
                  ) : (
                    <p>Nothing matches this filter.</p>
                  )}
                </CardContent>
              </Card>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  meta={meta.get(l.id)?.meta}
                  token={tokens.get(l.payToken.toLowerCase())}
                  verified={verified.get(l.target.toLowerCase())}
                  onOpen={() => setOpenId(l.id)}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="sell">
            <SellWizard wallet={wallet} registry={registry} onListed={() => void refresh()} />
          </TabsContent>

          <TabsContent value="mine" className="space-y-3">
            {!wallet.account && (
              <Card>
                <CardContent className="flex flex-wrap items-center gap-3 py-8 text-sm text-muted-foreground">
                  Connect a wallet to see your listings and purchases.
                  <Button size="sm" onClick={() => void wallet.connect()}>
                    Connect wallet
                  </Button>
                </CardContent>
              </Card>
            )}
            {wallet.account && mine.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">No listings or purchases from {short(wallet.account, 6)} yet.</CardContent>
              </Card>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {mine.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  meta={meta.get(l.id)?.meta}
                  token={tokens.get(l.payToken.toLowerCase())}
                  verified={verified.get(l.target.toLowerCase())}
                  onOpen={() => setOpenId(l.id)}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="how">
            <HowItWorks registry={registry} />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t border-border/60 py-4 text-center text-[11px] text-muted-foreground">
        The Lab is a frontend. The contracts are the product; read them, and host your own copy if you like.{" "}
        <a className="text-primary hover:underline" href={GUIDE} target="_blank" rel="noreferrer">
          Source and guide
        </a>
      </footer>

      <ListingDialog
        listing={openListing}
        record={openListing ? meta.get(openListing.id) : undefined}
        token={openListing ? tokens.get(openListing.payToken.toLowerCase()) : undefined}
        wallet={wallet}
        registry={registry}
        open={openListing !== null}
        onClose={() => setOpenId(null)}
        onChanged={() => void refresh()}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate font-mono text-lg ${tone === "green" ? "text-[var(--sb-green)]" : ""}`} title={value}>
        {value}
      </p>
    </Card>
  );
}

function WalletButton({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const [pick, setPick] = useState(false);
  useEffect(() => {
    if (wallet.error) toast.error("Wallet", { description: wallet.error });
  }, [wallet.error]);
  if (wallet.account) {
    return (
      <div className="flex items-center gap-1.5">
        {!wallet.onChain && (
          <Button size="sm" variant="outline" className="text-[var(--sb-gold)]" onClick={() => void wallet.switchChain()}>
            wrong network
          </Button>
        )}
        <Badge variant="outline" className="font-mono text-[11px]">
          {short(wallet.account, 4)}
        </Badge>
        <Button size="icon" variant="ghost" onClick={wallet.disconnect} aria-label="disconnect">
          <LogOut className="size-3.5" />
        </Button>
      </div>
    );
  }
  if (wallet.options.length > 1 && pick) {
    return (
      <div className="flex items-center gap-1">
        {wallet.options.map((o) => (
          <Button key={o.id} size="sm" variant="outline" onClick={() => void wallet.connect(o).then(() => setPick(false))}>
            {o.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.icon} alt="" className="size-3.5" />
            )}
            {o.name}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <Button size="sm" disabled={wallet.connecting} onClick={() => (wallet.options.length > 1 ? setPick(true) : void wallet.connect())}>
      <Wallet className="size-3.5" /> <span className="whitespace-nowrap">{wallet.connecting ? "Connecting…" : "Connect wallet"}</span>
    </Button>
  );
}
