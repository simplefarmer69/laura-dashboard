"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Code2, ExternalLink, Globe, MessageCircle, ShieldCheck, ShieldQuestion, XCircle } from "lucide-react";
import type { Address, WalletClient } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ERC20_ABI,
  FEE_BPS,
  MARKET_ABI,
  MARKET_ADDRESS,
  OWNABLE_ABI,
  REFUND_DELAY_S,
  ZERO_ADDRESS,
  explorerAddress,
  explorerContract,
  type Listing,
} from "@/lib/lab/contracts";
import { displayUrl, xProfileUrl, type ListingMetadata } from "@/lib/lab/metadata";
import { fetchAllowance, fetchBalance, fetchTargetInfo, type MetadataRecord, type TargetInfo, type TokenInfo } from "@/lib/lab/reads";
import { runTx } from "@/lib/lab/tx";
import type { WalletState } from "@/lib/lab/wallet";
import { ListingImage, listingName, statusBadge } from "@/components/lab/listing-card";
import { MetadataForm } from "@/components/lab/metadata-form";
import { ago, byteLength, countdown, fmtUnits, sameAddress, short } from "@/components/lab/format";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 py-1.5 text-xs last:border-0">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 text-right font-mono break-all">{children}</span>
    </div>
  );
}

function Check({ ok, warn, children }: { ok: boolean | null; warn?: boolean; children: React.ReactNode }) {
  const Icon = ok === true ? CheckCircle2 : ok === false ? (warn ? AlertTriangle : XCircle) : ShieldQuestion;
  const tone = ok === true ? "text-[var(--sb-green)]" : ok === false ? (warn ? "text-[var(--sb-gold)]" : "text-[var(--sb-neg)]") : "text-muted-foreground";
  return (
    <li className={`flex items-start gap-2 text-xs ${tone}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="text-foreground/90">{children}</span>
    </li>
  );
}

interface DialogProps {
  listing: Listing | null;
  record: MetadataRecord | undefined;
  token: TokenInfo | undefined;
  wallet: WalletState;
  registry: Address | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ListingDialog(props: DialogProps) {
  const { listing, open, onClose } = props;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        {listing && <ListingBody key={listing.id} {...props} listing={listing} />}
      </DialogContent>
    </Dialog>
  );
}

function ListingBody({ listing, record, token, wallet, registry, onChanged }: DialogProps & { listing: Listing }) {
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [tab, setTab] = useState<"details" | "edit" | "storefront">("details");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const t = setTimeout(tick, 0);
    const i = setInterval(tick, 30_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchTargetInfo(listing.target).then((t) => alive && setTarget(t));
    return () => {
      alive = false;
    };
  }, [listing]);

  useEffect(() => {
    const account = wallet.account;
    if (!account) return;
    let alive = true;
    void fetchBalance(listing.payToken, account).then((b) => alive && setBalance(b)).catch(() => undefined);
    if (listing.payToken !== ZERO_ADDRESS) {
      void fetchAllowance(listing.payToken, account, MARKET_ADDRESS).then((a) => alive && setAllowance(a)).catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [listing, wallet.account, busy]);

  const meta: ListingMetadata | undefined = record?.meta;
  const me = wallet.account;
  const isSeller = Boolean(listing && sameAddress(me, listing.seller));
  const isBuyer = Boolean(listing && sameAddress(me, listing.buyer));
  const client = wallet.client;

  const fee = listing ? (listing.price * BigInt(FEE_BPS)) / 10_000n : 0n;
  const refundAt = listing && listing.status === "sold" ? listing.soldAt + REFUND_DELAY_S : 0;
  const pendingToMarket = Boolean(target && sameAddress(target.pendingOwner, MARKET_ADDRESS));
  const ownerIsMarket = Boolean(target && sameAddress(target.owner, MARKET_ADDRESS));
  const ownerIsSeller = Boolean(listing && target && sameAddress(target.owner, listing.seller));
  const stale = Boolean(listing && listing.status === "listed" && target && target.owner && !ownerIsMarket && !ownerIsSeller);
  const needsApproval = Boolean(listing && listing.payToken !== ZERO_ADDRESS && allowance !== null && allowance < listing.price);
  const canAfford = balance === null || (listing ? balance >= listing.price : true);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      onChanged();
      if (listing) void fetchTargetInfo(listing.target).then(setTarget);
    }
  };

  const tx = (c: WalletClient, spec: Parameters<typeof runTx>[1]) => runTx(c, spec);

  const links = useMemo(() => {
    if (!meta) return [];
    const out: Array<{ label: string; href: string; Icon: typeof Globe }> = [];
    if (meta.website) out.push({ label: "website", href: displayUrl(meta.website), Icon: Globe });
    if (meta.github) out.push({ label: "github", href: displayUrl(meta.github), Icon: Code2 });
    if (meta.docs) out.push({ label: "docs", href: displayUrl(meta.docs), Icon: Globe });
    const x = xProfileUrl(meta.x);
    if (x) out.push({ label: meta.x.startsWith("@") ? meta.x : `@${meta.x.replace(/^.*\//, "")}`, href: x, Icon: MessageCircle });
    if (meta.telegram) out.push({ label: "telegram", href: displayUrl(meta.telegram), Icon: MessageCircle });
    if (meta.discord) out.push({ label: "discord", href: displayUrl(meta.discord), Icon: MessageCircle });
    return out;
  }, [meta]);

  const name = listingName(listing, meta, target?.name);
  const refundOpen = now > 0 && now >= refundAt;

  return (
    <>
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-base">{name}</DialogTitle>
            <span className="font-mono text-xs text-muted-foreground">listing #{listing.id}</span>
            {statusBadge(listing)}
          </div>
          <DialogDescription className="text-xs">
            Sells <strong>control</strong> of contract{" "}
            <a className="font-mono text-primary hover:underline" href={explorerContract(listing.target)} target="_blank" rel="noreferrer">
              {short(listing.target, 6)}
            </a>{" "}
            on Robinhood Chain. Ownership is escrowed by the market; payment is released to the seller only after delivery.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border/60 text-xs">
          {(["details", ...(isSeller && listing.status === "listed" ? (["edit"] as const) : []), ...(isSeller && registry ? (["storefront"] as const) : [])] as Array<"details" | "edit" | "storefront">).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 capitalize ${tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t === "edit" ? "edit terms" : t}
            </button>
          ))}
        </div>

        {tab === "details" && (
          <div className="grid gap-4 md:grid-cols-[260px_1fr]">
            <div className="space-y-3">
              <ListingImage src={meta?.image ?? ""} name={name} className="h-48 w-full rounded-md border border-border/60" />
              {links.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {links.map((l) => (
                    <a
                      key={l.label + l.href}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer nofollow"
                      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:border-primary/60"
                    >
                      <l.Icon className="size-3" /> {l.label}
                    </a>
                  ))}
                </div>
              )}
              {meta && meta.audits.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">audits (seller supplied)</p>
                  {meta.audits.map((a) => (
                    <a key={a.url} href={displayUrl(a.url)} target="_blank" rel="noreferrer nofollow" className="flex items-center gap-1 text-xs text-primary hover:underline">
                      <ShieldCheck className="size-3" /> {a.title} <ExternalLink className="size-3" />
                    </a>
                  ))}
                </div>
              )}
              {meta && meta.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {meta.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
              {record && !record.ok && <p className="text-[11px] text-[var(--sb-gold)]">The seller&apos;s storefront record did not parse; showing on-chain data only.</p>}
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">on-chain description</p>
                <p className="whitespace-pre-wrap text-sm">{listing.description || "—"}</p>
                {meta?.description && (
                  <>
                    <p className="mt-3 text-[10px] uppercase tracking-wide text-muted-foreground">seller&apos;s storefront description</p>
                    <p className="whitespace-pre-wrap text-xs text-foreground/90">{meta.description}</p>
                  </>
                )}
              </div>

              <div className="rounded-md border border-border/60 bg-black/30 p-3">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">trust check · live from chain</p>
                <ul className="space-y-1.5">
                  <Check ok={target ? target.isContract : null}>Target is a contract on Robinhood Chain</Check>
                  <Check ok={target ? target.verified : null} warn={false}>
                    Source verified on Blockscout{" "}
                    <a className="text-primary hover:underline" href={explorerContract(listing.target)} target="_blank" rel="noreferrer">
                      (read it before you buy)
                    </a>
                    {target && target.verified === null && <span className="text-muted-foreground"> · could not ask the explorer from this browser, open the link</span>}
                  </Check>
                  <Check ok={target ? (target.owner ? true : false) : null}>
                    owner() responds: {target?.owner ? <span className="font-mono">{short(target.owner, 6)}</span> : "no (not Ownable; the market cannot escrow it)"}
                    {target?.owner && ownerIsMarket && " (the market)"}
                    {target?.owner && ownerIsSeller && " (the seller)"}
                  </Check>
                  {listing.status === "listed" && (
                    <Check ok={listing.escrowed} warn={pendingToMarket}>
                      Market holds ownership right now: {listing.escrowed ? "yes, buy() will succeed" : pendingToMarket ? "pending (Ownable2Step): anyone can Accept escrow below" : "no, buy() reverts until the seller transfers ownership"}
                    </Check>
                  )}
                  {target?.twoStep && (
                    <Check ok={true}>
                      Ownable2Step contract: delivery names the buyer as pending owner, the buyer then calls acceptOwnership(). Nobody else can take it in between.
                    </Check>
                  )}
                  {stale && <Check ok={false}>Stale: ownership moved to a third party. Anyone can expire this listing.</Check>}
                  <Check ok={target ? target.verified === true : null} warn>
                    You are buying whatever the owner role controls in <em>that</em> contract (mint, fees, pause, upgrade, funds…). The market cannot judge that; its verified source can.
                  </Check>
                </ul>
              </div>

              <div>
                <Row k="price">{token ? `${fmtUnits(listing.price, token.decimals)} ${token.symbol}` : "…"}</Row>
                <Row k="protocol fee (1%)">{token ? `${fmtUnits(fee, token.decimals)} ${token.symbol}` : "…"}</Row>
                <Row k="seller receives">{token ? `${fmtUnits(listing.price - fee, token.decimals)} ${token.symbol}` : "…"}</Row>
                <Row k="payment token">
                  {listing.payToken === ZERO_ADDRESS ? (
                    "native ETH"
                  ) : (
                    <a className="text-primary hover:underline" href={explorerAddress(listing.payToken)} target="_blank" rel="noreferrer">
                      {short(listing.payToken, 6)}
                    </a>
                  )}
                </Row>
                <Row k="seller">
                  <a className="text-primary hover:underline" href={explorerAddress(listing.seller)} target="_blank" rel="noreferrer">
                    {short(listing.seller, 6)}
                  </a>
                  {isSeller && " (you)"}
                </Row>
                {listing.buyer !== ZERO_ADDRESS && (
                  <Row k="buyer">
                    <a className="text-primary hover:underline" href={explorerAddress(listing.buyer)} target="_blank" rel="noreferrer">
                      {short(listing.buyer, 6)}
                    </a>
                    {isBuyer && " (you)"}
                  </Row>
                )}
                <Row k="listed">{ago(listing.createdAt)}</Row>
                {listing.soldAt > 0 && <Row k="sold">{ago(listing.soldAt)}</Row>}
                {listing.status === "sold" && <Row k="refund opens">{countdown(refundAt)}</Row>}
                <Row k="market">
                  <a className="text-primary hover:underline" href={explorerContract(MARKET_ADDRESS)} target="_blank" rel="noreferrer">
                    {short(MARKET_ADDRESS, 6)}
                  </a>
                </Row>
              </div>

              <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">actions</p>
                {!me && <p className="text-xs text-muted-foreground">Connect a wallet to act on this listing. Reading is free for everyone.</p>}
                {me && !wallet.onChain && (
                  <Button size="sm" variant="outline" onClick={() => void wallet.switchChain()}>
                    Switch wallet to Robinhood Chain
                  </Button>
                )}
                {me && wallet.onChain && client && (
                  <div className="flex flex-wrap gap-2">
                    {listing.status === "listed" && pendingToMarket && !listing.escrowed && (
                      <Button size="sm" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "acceptEscrow", args: [BigInt(listing.id)], label: "Accept escrow" }))}>
                        Accept escrow (anyone)
                      </Button>
                    )}
                    {listing.status === "listed" && !isSeller && (
                      <div className="w-full space-y-2">
                        <label className="flex items-start gap-2 text-xs">
                          <input type="checkbox" className="mt-0.5" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                          <span>
                            I read the target&apos;s verified source and understand I am buying control of that contract, not a promise, and that the seller wrote the description.
                          </span>
                        </label>
                        {needsApproval && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !listing.escrowed}
                            onClick={() => void act(() => tx(client, { address: listing.payToken, abi: ERC20_ABI, functionName: "approve", args: [MARKET_ADDRESS, listing.price], label: `Approve ${token?.symbol ?? "token"}` }))}
                          >
                            1. Approve {token ? `${fmtUnits(listing.price, token.decimals)} ${token.symbol}` : "token"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={busy || !reviewed || !listing.escrowed || needsApproval || !canAfford}
                          onClick={() =>
                            void act(() =>
                              tx(client, {
                                address: MARKET_ADDRESS,
                                abi: MARKET_ABI,
                                functionName: "buy",
                                args: [BigInt(listing.id), listing.payToken, listing.price],
                                value: listing.payToken === ZERO_ADDRESS ? listing.price : 0n,
                                label: "Buy",
                              }),
                            )
                          }
                        >
                          {needsApproval ? "2. " : ""}Buy for {token ? `${fmtUnits(listing.price, token.decimals)} ${token.symbol}` : "…"}
                        </Button>
                        {!canAfford && <p className="text-xs text-[var(--sb-neg)]">Your balance is below the price.</p>}
                        {!listing.escrowed && <p className="text-xs text-[var(--sb-gold)]">Buying is disabled until the market holds ownership; the contract itself refuses (NotEscrowed).</p>}
                      </div>
                    )}
                    {listing.status === "listed" && isSeller && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "cancel", args: [BigInt(listing.id)], label: "Cancel listing" }))}>
                        Cancel listing{listing.escrowed ? " (ownership returns to you)" : ""}
                      </Button>
                    )}
                    {listing.status === "listed" && isSeller && !listing.escrowed && !pendingToMarket && ownerIsSeller && (
                      <Button size="sm" disabled={busy} onClick={() => void act(() => tx(client, { address: listing.target, abi: OWNABLE_ABI, functionName: "transferOwnership", args: [MARKET_ADDRESS], label: "Transfer ownership to market" }))}>
                        Transfer ownership to the market
                      </Button>
                    )}
                    {listing.status === "listed" && stale && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "expire", args: [BigInt(listing.id)], label: "Expire listing" }))}>
                        Expire stale listing (anyone)
                      </Button>
                    )}
                    {listing.status === "sold" && (
                      <Button size="sm" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "deliver", args: [BigInt(listing.id)], label: "Deliver" }))}>
                        Deliver ownership to buyer (anyone)
                      </Button>
                    )}
                    {listing.status === "sold" && isBuyer && (
                      <Button size="sm" variant="outline" disabled={busy || !refundOpen} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "refund", args: [BigInt(listing.id)], label: "Refund" }))}>
                        Refund {!refundOpen ? `(opens in ${countdown(refundAt)})` : ""}
                      </Button>
                    )}
                    {listing.status === "delivered" && isSeller && !listing.proceedsClaimed && (
                      <Button size="sm" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "claimProceeds", args: [BigInt(listing.id)], label: "Claim proceeds" }))}>
                        Claim proceeds ({token ? `${fmtUnits(listing.price - fee, token.decimals)} ${token.symbol}` : "…"})
                      </Button>
                    )}
                    {listing.status === "delivered" && isBuyer && target?.twoStep && sameAddress(target.pendingOwner, me) && (
                      <Button size="sm" disabled={busy} onClick={() => void act(() => tx(client, { address: listing.target, abi: OWNABLE_ABI, functionName: "acceptOwnership", label: "Accept ownership" }))}>
                        Accept ownership (Ownable2Step)
                      </Button>
                    )}
                    {listing.status === "refunded" && isSeller && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => tx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "cancel", args: [BigInt(listing.id)], label: "Reclaim ownership" }))}>
                        Close and take ownership back
                      </Button>
                    )}
                    {listing.status === "delivered" && listing.proceedsClaimed && <p className="text-xs text-muted-foreground">Complete. Proceeds claimed.</p>}
                    {listing.status === "cancelled" && <p className="text-xs text-muted-foreground">Closed.</p>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "edit" && client && <EditTerms listing={listing} token={token} client={client} onDone={() => act(async () => undefined)} />}

        {tab === "storefront" && client && registry && (
          <MetadataForm listingId={listing.id} registry={registry} client={client} initial={record?.ok ? record.meta : undefined} onSaved={() => act(async () => undefined)} />
        )}
    </>
  );
}

function EditTerms({ listing, token, client, onDone }: { listing: Listing; token: TokenInfo | undefined; client: WalletClient; onDone: () => void }) {
  const decimals = token?.decimals ?? 18;
  const [price, setPrice] = useState(fmtUnits(listing.price, decimals, 18).replace(/,/g, ""));
  const [description, setDescription] = useState(listing.description);
  const [busy, setBusy] = useState(false);
  const bytes = byteLength(description);
  let priceWei = 0n;
  try {
    priceWei = parsePrice(price, decimals);
  } catch {
    priceWei = 0n;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Price and description can change while unsold. The payment token stays {token?.symbol ?? "the same"}; buyers pass the exact terms they saw, so an edit in flight makes their buy revert instead of overcharging them.</p>
      <div className="space-y-1">
        <Label className="text-xs">Price ({token?.symbol ?? "token"})</Label>
        <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
      </div>
      <div className="space-y-1">
        <div className="flex justify-between">
          <Label className="text-xs">On-chain description</Label>
          <span className={`text-[10px] ${bytes > 280 ? "text-[var(--sb-neg)]" : "text-muted-foreground"}`}>{bytes}/280 bytes</span>
        </div>
        <Textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <Button
        size="sm"
        disabled={busy || priceWei === 0n || bytes > 280}
        onClick={async () => {
          setBusy(true);
          await runTx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "updateListing", args: [BigInt(listing.id), listing.payToken, priceWei, description], label: "Update listing" });
          setBusy(false);
          onDone();
        }}
      >
        Save terms
      </Button>
    </div>
  );
}

export function parsePrice(text: string, decimals: number): bigint {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") throw new Error("bad number");
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error("too many decimals");
  return BigInt((w || "0") + f.padEnd(decimals, "0"));
}
