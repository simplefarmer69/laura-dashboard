"use client";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, Search, XCircle } from "lucide-react";
import { decodeEventLog, isAddress, type Address } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MARKET_ABI, MARKET_ADDRESS, OWNABLE_ABI, PAYMENT_PRESETS, ZERO_ADDRESS, explorerContract } from "@/lib/lab/contracts";
import { fetchListing, fetchTargetInfo, fetchTokenInfo, labClient, type TargetInfo, type TokenInfo } from "@/lib/lab/reads";
import { runTx } from "@/lib/lab/tx";
import type { WalletState } from "@/lib/lab/wallet";
import { MetadataForm } from "@/components/lab/metadata-form";
import { parsePrice } from "@/components/lab/listing-dialog";
import { byteLength, sameAddress, short } from "@/components/lab/format";

type Step = 1 | 2 | 3 | 4 | 5;

/**
 * Seller flow in the order the contract requires: check the target, set the
 * terms, createListing, transferOwnership(market) (+ acceptEscrow for
 * Ownable2Step), then the optional storefront record. Every step re-reads
 * the chain, so the page never claims an escrow it cannot see.
 */
export function SellWizard({ wallet, registry, onListed }: { wallet: WalletState; registry: Address | null; onListed: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [targetText, setTargetText] = useState("");
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [activeId, setActiveId] = useState<number>(0);
  const [checking, setChecking] = useState(false);
  const [preset, setPreset] = useState<string>(ZERO_ADDRESS);
  const [customToken, setCustomToken] = useState("");
  const [tokenState, setToken] = useState<TokenInfo | null>(null);
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [listingId, setListingId] = useState<number | null>(null);
  const [escrowed, setEscrowed] = useState(false);
  const [pendingToMarket, setPendingToMarket] = useState(false);

  const me = wallet.account;
  const client = wallet.client;
  const tokenAddress: Address | null = preset === "custom" ? (isAddress(customToken) ? (customToken as Address) : null) : (preset as Address);

  useEffect(() => {
    if (!tokenAddress) return;
    let alive = true;
    void fetchTokenInfo(tokenAddress).then((t) => alive && setToken(t));
    return () => {
      alive = false;
    };
  }, [tokenAddress]);
  const token = tokenAddress && tokenState && sameAddress(tokenState.address, tokenAddress) ? tokenState : null;

  const check = async () => {
    if (!isAddress(targetText)) return;
    setChecking(true);
    try {
      const [info, active] = await Promise.all([
        fetchTargetInfo(targetText as Address),
        labClient().readContract({ address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "activeListingOf", args: [targetText as Address] }),
      ]);
      setTarget(info);
      setActiveId(Number(active));
    } finally {
      setChecking(false);
    }
  };

  const refreshEscrow = async (id: number, targetAddr: Address) => {
    const [l, info] = await Promise.all([fetchListing(id), fetchTargetInfo(targetAddr)]);
    setEscrowed(Boolean(l?.escrowed));
    setPendingToMarket(Boolean(info.pendingOwner && sameAddress(info.pendingOwner, MARKET_ADDRESS)));
    setTarget(info);
  };

  const ownerOk = Boolean(target && me && sameAddress(target.owner, me));
  const targetOk = Boolean(target && target.isContract && ownerOk && activeId === 0);
  let priceWei = 0n;
  try {
    priceWei = token ? parsePrice(price, token.decimals) : 0n;
  } catch {
    priceWei = 0n;
  }
  const descBytes = byteLength(description);
  const termsOk = Boolean(tokenAddress && priceWei > 0n && descBytes <= 280);

  const createListing = async () => {
    if (!client || !target || !tokenAddress) return;
    setBusy(true);
    try {
      const hash = await runTx(client, {
        address: MARKET_ADDRESS,
        abi: MARKET_ABI,
        functionName: "createListing",
        args: [target.address, tokenAddress, priceWei, description],
        label: "Create listing",
      });
      if (!hash) return;
      const receipt = await labClient().getTransactionReceipt({ hash });
      let id: number | null = null;
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: MARKET_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "Listed") id = Number((ev.args as { id: bigint }).id);
        } catch {
          /* other logs */
        }
      }
      if (id === null) {
        id = Number(await labClient().readContract({ address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "activeListingOf", args: [target.address] }));
      }
      setListingId(id);
      setStep(4);
      onListed();
    } finally {
      setBusy(false);
    }
  };

  const transfer = async () => {
    if (!client || !target || listingId === null) return;
    setBusy(true);
    try {
      const hash = await runTx(client, { address: target.address, abi: OWNABLE_ABI, functionName: "transferOwnership", args: [MARKET_ADDRESS], label: "Transfer ownership to market" });
      if (hash) await refreshEscrow(listingId, target.address);
      onListed();
    } finally {
      setBusy(false);
    }
  };

  const acceptEscrow = async () => {
    if (!client || !target || listingId === null) return;
    setBusy(true);
    try {
      const hash = await runTx(client, { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "acceptEscrow", args: [BigInt(listingId)], label: "Accept escrow" });
      if (hash) await refreshEscrow(listingId, target.address);
      onListed();
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sell a contract you own</CardTitle>
          <CardDescription className="text-xs">Connect the wallet that is the current owner() of the contract. Listing takes three transactions: create the listing, transfer ownership to the market, and (optionally) publish the storefront.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void wallet.connect()} disabled={wallet.connecting}>
            Connect wallet
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!wallet.onChain) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm">
          Your wallet is on another network.
          <Button size="sm" onClick={() => void wallet.switchChain()}>
            Switch to Robinhood Chain
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-[11px]">
        {(["Check the contract", "Set the terms", "Create listing", "Escrow ownership", "Storefront"] as const).map((label, i) => {
          const n = (i + 1) as Step;
          const state = n < step ? "done" : n === step ? "now" : "todo";
          return (
            <li key={label} className={`flex items-center gap-1 rounded-full border px-2.5 py-1 ${state === "now" ? "border-primary text-foreground" : state === "done" ? "border-[var(--sb-green)]/50 text-[var(--sb-green)]" : "border-border/60 text-muted-foreground"}`}>
              {state === "done" ? <CheckCircle2 className="size-3" /> : <span className="font-mono">{n}</span>} {label}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">1 · Which contract?</CardTitle>
            <CardDescription className="text-xs">Paste the address. It must expose owner() and transferOwnership(address) (OpenZeppelin Ownable / Ownable2Step, most NFT collections, tokens, vaults), and your connected wallet must be its owner.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input value={targetText} onChange={(e) => setTargetText(e.target.value.trim())} placeholder="0x…" className="font-mono" />
              <Button variant="outline" onClick={() => void check()} disabled={!isAddress(targetText) || checking}>
                {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Check
              </Button>
            </div>
            {target && (
              <ul className="space-y-1 text-xs">
                <Line ok={target.isContract}>Has code on Robinhood Chain</Line>
                <Line ok={Boolean(target.owner)}>owner() responds{target.owner ? `: ${short(target.owner, 6)}` : " (not Ownable)"}</Line>
                <Line ok={ownerOk}>Your wallet is the owner</Line>
                <Line ok={activeId === 0}>{activeId === 0 ? "No live listing for this contract" : `Already listed as #${activeId}`}</Line>
                <Line ok={target.verified === true} soft>
                  Source verified on Blockscout{target.verified === null ? " (unknown from this browser)" : ""}{" "}
                  <a className="text-primary hover:underline" href={explorerContract(target.address)} target="_blank" rel="noreferrer">
                    open <ExternalLink className="inline size-3" />
                  </a>
                  {target.verified !== true && <span className="text-muted-foreground"> · verify it first; buyers will not pay for code they cannot read</span>}
                </Line>
                {target.twoStep && <Line ok>Ownable2Step detected: after transferOwnership you will also click Accept escrow</Line>}
              </ul>
            )}
            <Button disabled={!targetOk} onClick={() => setStep(2)}>
              Continue <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 2 && target && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">2 · Terms</CardTitle>
            <CardDescription className="text-xs">Any token works as payment. The market takes 1% of the sale; you receive the rest when you claim after delivery.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Payment token</Label>
                <select value={preset} onChange={(e) => setPreset(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">
                  {PAYMENT_PRESETS.map((p) => (
                    <option key={p.address} value={p.address}>
                      {p.symbol}
                    </option>
                  ))}
                  <option value="custom">Other ERC-20 address…</option>
                </select>
                {preset === "custom" && <Input value={customToken} onChange={(e) => setCustomToken(e.target.value.trim())} placeholder="0x… token address" className="mt-1 font-mono" />}
                {token && <p className="text-[11px] text-muted-foreground">{token.symbol} · {token.decimals} decimals</p>}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Price {token ? `(${token.symbol})` : ""}</Label>
                <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.5" />
                {priceWei > 0n && <p className="text-[11px] text-muted-foreground">you receive 99%: {token ? `${(Number(price) * 0.99).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol}` : ""}</p>}
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <Label className="text-xs">On-chain description</Label>
                <span className={`text-[10px] ${descBytes > 280 ? "text-[var(--sb-neg)]" : "text-muted-foreground"}`}>{descBytes}/280 bytes</span>
              </div>
              <Textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="One or two sentences: what it is and what the owner controls. Longer text, image and links go in the storefront step." />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button disabled={!termsOk} onClick={() => setStep(3)}>
                Continue <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && target && token && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">3 · Create the listing</CardTitle>
            <CardDescription className="text-xs">ORDER MATTERS: the listing is created first, while you are still the owner. Only then does ownership move. Ownership sent to the market without a listing cannot be returned.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <ul className="space-y-1 font-mono">
              <li>target: {target.address}</li>
              <li>payToken: {tokenAddress === ZERO_ADDRESS ? "native ETH" : tokenAddress}</li>
              <li>price: {price} {token.symbol}</li>
              <li>description: {description}</li>
            </ul>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)} disabled={busy}>
                Back
              </Button>
              <Button onClick={() => void createListing()} disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} createListing()
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && target && listingId !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">4 · Escrow the ownership (listing #{listingId})</CardTitle>
            <CardDescription className="text-xs">
              Call transferOwnership on YOUR contract with the market as the new owner. Buyers cannot pay until the market really holds owner(); the contract checks it live.
              {target.twoStep && " This is an Ownable2Step contract, so a second click (Accept escrow) completes the handover; anyone may click it."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1 text-xs">
              <Line ok={escrowed || pendingToMarket}>transferOwnership({short(MARKET_ADDRESS, 6)}) sent{pendingToMarket && !escrowed ? " (pending, accept below)" : ""}</Line>
              <Line ok={escrowed}>Market is owner() of your contract: {escrowed ? "yes, the listing is live" : "not yet"}</Line>
            </ul>
            <div className="flex flex-wrap gap-2">
              {!escrowed && !pendingToMarket && (
                <Button onClick={() => void transfer()} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} transferOwnership(market)
                </Button>
              )}
              {!escrowed && pendingToMarket && (
                <Button onClick={() => void acceptEscrow()} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} acceptEscrow(#{listingId})
                </Button>
              )}
              <Button variant="outline" onClick={() => void refreshEscrow(listingId, target.address)} disabled={busy}>
                Re-check
              </Button>
              <Button variant={escrowed ? "default" : "outline"} onClick={() => setStep(5)}>
                {escrowed ? "Continue to storefront" : "Skip for now"} <ArrowRight className="size-3.5" />
              </Button>
            </div>
            {!escrowed && <p className="text-[11px] text-muted-foreground">You can finish this later from the listing: open it under My activity and use Transfer ownership / Accept escrow.</p>}
          </CardContent>
        </Card>
      )}

      {step === 5 && listingId !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">5 · Storefront (optional, recommended)</CardTitle>
            <CardDescription className="text-xs">Image, long description, website, GitHub, socials and audit links, stored on-chain in the Lab registry under listing #{listingId}. Only you (the seller) can write it. Buyers see it on every frontend that reads the registry.</CardDescription>
          </CardHeader>
          <CardContent>
            {registry && client ? (
              <MetadataForm listingId={listingId} registry={registry} client={client} initial={undefined} onSaved={onListed} />
            ) : (
              <p className="text-xs text-muted-foreground">The Lab registry is being deployed by the swarm; storefront editing opens automatically once it is verified. Your listing is live meanwhile.</p>
            )}
            <div className="mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setStep(1);
                  setTarget(null);
                  setTargetText("");
                  setListingId(null);
                  setEscrowed(false);
                  setPendingToMarket(false);
                  setPrice("");
                  setDescription("");
                }}
              >
                List another contract
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Line({ ok, soft, children }: { ok: boolean; soft?: boolean; children: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <li className={`flex items-start gap-2 ${ok ? "text-[var(--sb-green)]" : soft ? "text-[var(--sb-gold)]" : "text-[var(--sb-neg)]"}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="text-foreground/90">{children}</span>
    </li>
  );
}
