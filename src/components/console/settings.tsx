"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import type { Settings } from "@/lib/types";

export function SettingsPanel({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<Settings>(state.settings);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setBusy(true);
    try {
      await patchJson("/api/settings", form);
      toast.success("Settings saved");
      await refresh();
    } catch (err) {
      toast.error("Save failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">Grader targets</CardTitle>
          <CardDescription>
            Where the grader reads price (DexScreener) and protocol revenue/volume (DefiLlama).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Token address" hint="ERC-20 graded on price">
            <Input value={form.tokenAddress} onChange={(e) => set("tokenAddress", e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="DexScreener chain slug">
            <Input value={form.chainSlug} onChange={(e) => set("chainSlug", e.target.value)} />
          </Field>
          <Field label="Chain ID">
            <Input type="number" value={form.chainId} onChange={(e) => set("chainId", Number(e.target.value))} />
          </Field>
          <Field label="DefiLlama protocol slug">
            <Input value={form.llamaSlug} onChange={(e) => set("llamaSlug", e.target.value)} />
          </Field>
          <Field label="Project name">
            <Input value={form.projectName} onChange={(e) => set("projectName", e.target.value)} />
          </Field>
          <Field label="Project site" hint="Docs are fetched from /docs">
            <Input value={form.projectSite} onChange={(e) => set("projectSite", e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Swarm behaviour</CardTitle>
          <CardDescription>Cadence, output budget and autonomy level.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Rest gap between cycles (minutes)" hint="LAURA runs around the clock: the next LLM cycle starts this many minutes after the previous one ends; trigger events (launch live, milestone) can cut a longer gap short">
            <Input
              type="number"
              min={1}
              max={1440}
              value={form.cycleIntervalMinutes}
              onChange={(e) => set("cycleIntervalMinutes", Number(e.target.value))}
            />
          </Field>
          <Field label="Max LLM cycles per day" hint="Hard rolling-24h budget on API spend; scheduled and event cycles defer once it's spent">
            <Input
              type="number"
              min={1}
              max={96}
              value={form.maxLlmCyclesPerDay}
              onChange={(e) => set("maxLlmCyclesPerDay", Number(e.target.value))}
            />
          </Field>
          <Field label="Max drafts per cycle">
            <Input
              type="number"
              min={1}
              max={20}
              value={form.maxDraftsPerCycle}
              onChange={(e) => set("maxDraftsPerCycle", Number(e.target.value))}
            />
          </Field>
          <Field label="LLM model override" hint="Blank uses the provider default">
            <Input value={form.llmModel} onChange={(e) => set("llmModel", e.target.value)} placeholder="e.g. claude-sonnet-4-5" />
          </Field>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Auto-tune parameters</Label>
              <p className="text-[11px] text-muted-foreground">
                Once per day the tuner adjusts cadence (45–360 min) and draft budget (3–8) from grade
                trend, review backlog and approval rates. Every change is logged in Activity.
              </p>
            </div>
            <Switch checked={form.autoTune} onCheckedChange={(v) => set("autoTune", Boolean(v))} />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Auto-apply strategy proposals</Label>
              <p className="text-[11px] text-muted-foreground">
                Lets the coach rewrite agent strategy text without review. Publishing drafts is always gated.
              </p>
            </div>
            <Switch
              checked={form.autoApplyStrategyProposals}
              onCheckedChange={(v) => set("autoApplyStrategyProposals", Boolean(v))}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Auto-approve all proposals</Label>
              <p className="text-[11px] text-muted-foreground">
                Full autonomy: drafts, strategy proposals and launch specs approve on creation, and any
                pending backlog is swept to approved. Launch hard caps and external publishing stay gated.
              </p>
            </div>
            <Switch
              checked={form.autoApproveProposals}
              onCheckedChange={(v) => set("autoApproveProposals", Boolean(v))}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Auto-claim creator earnings</Label>
              <p className="text-[11px] text-muted-foreground">
                Claims the flushCreatorQuote fallback ledger autonomously (simulated first, ≥0.0001 quote,
                max once/day per launch). Fees are normally push-paid per trade, so this usually stays idle.
              </p>
            </div>
            <Switch
              checked={form.autoClaimEarnings}
              onCheckedChange={(v) => set("autoClaimEarnings", Boolean(v))}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Mint freedom</Label>
              <p className="text-[11px] text-muted-foreground">
                Wide launch mandate: no cooldown between launches and a deeper launch queue, so
                justified launches flow as fast as Mint has something to say; there is no daily
                launch limit. Hard rails still bound spend per deploy, pacing (20 min apart) and
                the wallet floor. Off returns Mint to the slow pace (12h cooldown, 2 open specs).
              </p>
            </div>
            <Switch
              checked={form.mintFreedom}
              onCheckedChange={(v) => set("mintFreedom", Boolean(v))}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="text-xs">Autonomous X publishing</Label>
              <p className="text-[11px] text-muted-foreground">
                Fresh approved X drafts (under 6h old) post themselves, one per tick, inside the shared-account
                guards: 30 min between posts, 6 per 24h, duplicate memory, never engaging the account itself.
                Idle until X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET exist. Older approvals never auto-post.
              </p>
            </div>
            <Switch
              checked={form.autoPublishX}
              onCheckedChange={(v) => set("autoPublishX", Boolean(v))}
            />
          </div>
          <Button className="w-full" disabled={busy} onClick={() => void save()}>
            <Save className="size-3.5" /> Save settings
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-sm">Runtime</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <p>
            LLM provider: <span className="font-mono text-foreground">{state.runtime.llmProvider}</span>
            {state.runtime.llmProvider === "mock" && ". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable real generation."}
          </p>
          <p>
            Model: <span className="font-mono text-foreground">{state.runtime.llmModel}</span>
          </p>
          <p>
            Autopilot:{" "}
            <span className={`font-mono ${state.runtime.autopilot ? "text-[var(--sb-green)]" : "text-destructive"}`}>
              {state.runtime.autopilot ? "running in-process" : "off"}
            </span>
            {state.runtime.autopilot
              ? `: continuous cycles with a ${state.settings.cycleIntervalMinutes}-min rest gap between them (max ${state.settings.maxLlmCyclesPerDay}/day, plus event triggers) and a grade stamp every UTC day.`
              : ". Set SWARM_AUTOPILOT=1 (default) or run npm run worker."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
