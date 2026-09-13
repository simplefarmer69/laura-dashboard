"use client";
import { ExternalLink } from "lucide-react";
import type { Address } from "viem";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MARKET_ADDRESS, explorerContract } from "@/lib/lab/contracts";

const REPO = "https://github.com/simplefarmer69/laura-dashboard";

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/50 font-mono text-[11px] text-primary">{n}</span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

export function HowItWorks({ registry }: { registry: Address | null }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Selling</CardTitle>
          <CardDescription className="text-xs">Three transactions from the wallet that owns the contract. Order matters.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            <Step n="1" title="createListing(target, payToken, price, description)">
              While you are still owner(). Any ERC-20 or native ETH (address 0) as payment; price in the token&apos;s smallest unit; up to 280 bytes of description.
            </Step>
            <Step n="2" title="transferOwnership(market) on YOUR contract">
              The market becomes the escrow owner. Ownable2Step contracts only name the market as pending owner; then anyone calls acceptEscrow(id) and the market checks it really is owner().
            </Step>
            <Step n="3" title="setMetadata(id, json) on the Lab registry (optional)">
              Image, long description, website, GitHub, X, Telegram, Discord, audits. Seller-only, checked against the market on every write.
            </Step>
            <Step n="4" title="claimProceeds(id) after delivery">
              Price minus the 1% protocol fee. Until then the payment sits in the market; if the buyer refunds because nobody delivered, cancel(id) returns the ownership to you.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Buying</CardTitle>
          <CardDescription className="text-xs">You are buying control of a contract. Read its verified source first; the description is the seller&apos;s.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            <Step n="1" title="Check the trust panel">
              Source verified, owner() is the market (otherwise buy() reverts NotEscrowed and nothing is charged), whether it is Ownable2Step, and what the owner role controls in that specific contract.
            </Step>
            <Step n="2" title="buy(id, expectedPayToken, expectedPrice)">
              Native listings: send exactly the price. Token listings: approve the market first. The expected terms make an in-flight price edit revert instead of overcharging you.
            </Step>
            <Step n="3" title="deliver(id), by anyone">
              The market transfers ownership to you and only then books the 1% fee; if the target does not hand over, the call reverts and nothing is booked. Ownable2Step: you finish with acceptOwnership() on the contract; nobody can take it in between.
            </Step>
            <Step n="4" title="refund(id) if nobody delivered within 24h">
              Your payment comes back in full. The market has no admin who could hold it.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What the market cannot protect you from</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            A listing is a sale of the <em>owner role</em> of the target contract, exactly as that contract implements it. The market verifies that ownership really moved (owner() or pendingOwner() equals the buyer after
            delivery) and holds the payment until it did. It cannot verify what the role is worth: a contract can have a hidden second admin, a mint the owner cannot stop, or an upgrade path that
            makes owner() decorative. The only defence is the target&apos;s verified source, which is why the trust panel puts it first and why unverified targets are flagged in red.
          </p>
          <p>Storefront metadata (name, image, links, audits) is written by the seller and rendered as plain text and links. It is context, not a certificate.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Contracts and hosting your own frontend</CardTitle>
          <CardDescription className="text-xs">No owner, no admin, no pause, no upgrade path. The fee recipient is fixed at deploy.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">OwnershipMarket</span>
            <a className="inline-flex items-center gap-1 font-mono text-primary hover:underline" href={explorerContract(MARKET_ADDRESS)} target="_blank" rel="noreferrer">
              {MARKET_ADDRESS} <ExternalLink className="size-3" />
            </a>
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">LabRegistry</span>
            {registry ? (
              <a className="inline-flex items-center gap-1 font-mono text-primary hover:underline" href={explorerContract(registry)} target="_blank" rel="noreferrer">
                {registry} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span>deploying (the swarm verifies it before this page uses it)</span>
            )}
          </p>
          <p className="text-muted-foreground">
            Source, 34 foundry tests and the audit notes:{" "}
            <a className="text-primary hover:underline" href={`${REPO}/tree/main/src/lib/forge/contracts`} target="_blank" rel="noreferrer">
              contracts
            </a>
            ,{" "}
            <a className="text-primary hover:underline" href={`${REPO}/tree/main/audits`} target="_blank" rel="noreferrer">
              audits
            </a>
            ,{" "}
            <a className="text-primary hover:underline" href={`${REPO}/blob/main/docs/THE-LAB.md`} target="_blank" rel="noreferrer">
              guide
            </a>
            . This page is <code>src/components/lab</code> in the same repository: a static client that talks to the chain through a public RPC and to no server of LAURA&apos;s. Copy it, change the RPC if you want, host it anywhere. The
            market does not care which frontend a transaction came from.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
