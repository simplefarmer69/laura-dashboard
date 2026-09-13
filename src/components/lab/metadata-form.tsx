"use client";
import { useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { Address, WalletClient } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REGISTRY_ABI } from "@/lib/lab/contracts";
import { EMPTY_METADATA, METADATA_MAX_BYTES, metadataBytes, metadataSchema, serializeMetadata, type ListingMetadata } from "@/lib/lab/metadata";
import { runTx } from "@/lib/lab/tx";
import { ListingImage } from "@/components/lab/listing-card";

/**
 * Seller-side storefront editor. Writes one JSON record to the Lab registry
 * (seller-only, checked on-chain). Everything is optional; empty fields are
 * dropped from the JSON so the seller only pays for what they fill in.
 */
export function MetadataForm({
  listingId,
  registry,
  client,
  initial,
  onSaved,
}: {
  listingId: number;
  registry: Address;
  client: WalletClient;
  initial: ListingMetadata | undefined;
  onSaved: () => void;
}) {
  const [meta, setMeta] = useState<ListingMetadata>(initial ?? EMPTY_METADATA);
  const [busy, setBusy] = useState(false);
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(", "));

  const parsed = useMemo(() => metadataSchema.safeParse({ ...meta, tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean) }), [meta, tagsText]);
  const bytes = parsed.success ? metadataBytes(parsed.data) : 0;
  const tooBig = bytes > METADATA_MAX_BYTES;
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "field"}: ${i.message}`);

  const set = <K extends keyof ListingMetadata>(k: K, v: ListingMetadata[K]) => setMeta((m) => ({ ...m, [k]: v }));

  const save = async () => {
    if (!parsed.success || tooBig) return;
    setBusy(true);
    const hash = await runTx(client, {
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "setMetadata",
      args: [BigInt(listingId), serializeMetadata(parsed.data)],
      label: "Save storefront",
    });
    setBusy(false);
    if (hash) onSaved();
  };

  const clear = async () => {
    setBusy(true);
    const hash = await runTx(client, { address: registry, abi: REGISTRY_ABI, functionName: "clearMetadata", args: [BigInt(listingId)], label: "Clear storefront" });
    setBusy(false);
    if (hash) onSaved();
  };

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_220px]">
      <div className="space-y-3">
        <Field label="Name" hint="80 chars">
          <Input value={meta.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="Tip Jar v2, Meebits-style collection, …" />
        </Field>
        <Field label="Description" hint={`${meta.description.length}/1500`}>
          <Textarea
            value={meta.description}
            maxLength={1500}
            rows={5}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What the contract does, what the owner controls (mint, fees, pause, upgrade…), what a buyer gets, why you are selling."
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Image URL" hint="https or ipfs">
            <Input value={meta.image} onChange={(e) => set("image", e.target.value)} placeholder="https://… or ipfs://…" />
          </Field>
          <Field label="Website">
            <Input value={meta.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
          </Field>
          <Field label="GitHub">
            <Input value={meta.github} onChange={(e) => set("github", e.target.value)} placeholder="https://github.com/…" />
          </Field>
          <Field label="Docs">
            <Input value={meta.docs} onChange={(e) => set("docs", e.target.value)} placeholder="https://" />
          </Field>
          <Field label="X handle">
            <Input value={meta.x} onChange={(e) => set("x", e.target.value)} placeholder="@handle" />
          </Field>
          <Field label="Telegram">
            <Input value={meta.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/…" />
          </Field>
          <Field label="Discord">
            <Input value={meta.discord} onChange={(e) => set("discord", e.target.value)} placeholder="https://discord.gg/…" />
          </Field>
          <Field label="Tags" hint="comma separated, 6 max">
            <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="nft, game, vault" />
          </Field>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Audits</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={meta.audits.length >= 6}
              onClick={() => set("audits", [...meta.audits, { title: "", url: "" }])}
            >
              <Plus className="size-3.5" /> add audit
            </Button>
          </div>
          {meta.audits.length === 0 && <p className="text-xs text-muted-foreground">Link every audit or review the contract has had. Buyers look for this first.</p>}
          {meta.audits.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input
                value={a.title}
                maxLength={80}
                placeholder="Auditor / title"
                onChange={(e) => set("audits", meta.audits.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              />
              <Input
                value={a.url}
                placeholder="https://…"
                onChange={(e) => set("audits", meta.audits.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              />
              <Button type="button" size="icon" variant="ghost" onClick={() => set("audits", meta.audits.filter((_, j) => j !== i))} aria-label="remove audit">
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        {issues.length > 0 && (
          <ul className="space-y-0.5 text-xs text-[var(--sb-neg)]">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save()} disabled={busy || !parsed.success || tooBig}>
            <Save className="size-3.5" /> Save on-chain
          </Button>
          {initial && (
            <Button type="button" variant="outline" onClick={() => void clear()} disabled={busy}>
              <Trash2 className="size-3.5" /> Clear
            </Button>
          )}
          <span className={`text-xs ${tooBig ? "text-[var(--sb-neg)]" : "text-muted-foreground"}`}>
            {bytes} / {METADATA_MAX_BYTES} bytes · one transaction, paid in ETH gas
          </span>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">preview</p>
        <ListingImage src={meta.image} name={meta.name || "preview"} className="h-40 w-full rounded-md border border-border/60" />
        <p className="text-sm font-medium">{meta.name || "Untitled"}</p>
        <p className="line-clamp-4 text-xs text-muted-foreground">{meta.description || "Description preview"}</p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
