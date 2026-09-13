"use client";
import { useState } from "react";
import { Boxes, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { Listing } from "@/lib/lab/contracts";
import { displayUrl, type ListingMetadata } from "@/lib/lab/metadata";
import type { TokenInfo } from "@/lib/lab/reads";
import { ago, fmtUnits, short } from "@/components/lab/format";

export function statusBadge(l: Listing) {
  switch (l.status) {
    case "listed":
      return l.escrowed ? (
        <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">for sale · escrowed</Badge>
      ) : (
        <Badge variant="outline" className="text-[var(--sb-gold)]">listed · awaiting transfer</Badge>
      );
    case "sold":
      return <Badge variant="outline" className="text-[var(--sb-gold)]">sold · awaiting delivery</Badge>;
    case "delivered":
      return <Badge variant="secondary">delivered</Badge>;
    case "cancelled":
      return <Badge variant="secondary">cancelled</Badge>;
    case "refunded":
      return <Badge variant="destructive">refunded</Badge>;
    case "none":
      return <Badge variant="secondary">—</Badge>;
    default: {
      const _exhaustive: never = l.status;
      return _exhaustive;
    }
  }
}

export function ListingImage({ src, name, className }: { src: string; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-primary/25 via-black/40 to-black/70 ${className ?? ""}`}>
        <Boxes className="size-8 text-primary/70" />
        <span className="sr-only">{name}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={displayUrl(src)}
      alt={name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={`object-cover ${className ?? ""}`}
    />
  );
}

export function listingName(l: Listing, meta: ListingMetadata | undefined, targetName?: string | null): string {
  return meta?.name || targetName || `Contract ${short(l.target)}`;
}

export function ListingCard({
  listing,
  meta,
  token,
  verified,
  onOpen,
}: {
  listing: Listing;
  meta: ListingMetadata | undefined;
  token: TokenInfo | undefined;
  verified: boolean | null | undefined;
  onOpen: () => void;
}) {
  const name = listingName(listing, meta);
  const blurb = meta?.description || listing.description;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      className="group cursor-pointer overflow-hidden p-0 transition hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary"
    >
      <ListingImage src={meta?.image ?? ""} name={name} className="h-36 w-full" />
      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-1 text-sm font-medium">{name}</h3>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{listing.id}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {statusBadge(listing)}
          {verified === true && (
            <Badge variant="outline" className="gap-1 text-[10px] text-[var(--sb-green)]">
              <ShieldCheck className="size-3" /> verified source
            </Badge>
          )}
          {verified === false && (
            <Badge variant="outline" className="gap-1 text-[10px] text-[var(--sb-neg)]">
              <ShieldQuestion className="size-3" /> unverified source
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{blurb || "No description."}</p>
        <div className="flex items-end justify-between gap-2 border-t border-border/60 pt-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">price</p>
            <p className="font-mono text-sm">
              {token ? `${fmtUnits(listing.price, token.decimals)} ${token.symbol}` : "…"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">target</p>
            <p className="font-mono text-xs">{short(listing.target)}</p>
            <p className="text-[10px] text-muted-foreground">{ago(listing.createdAt)}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}
