"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizonal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { VIEWER_MODE } from "@/components/console/viewer";

interface Msg {
  role: "user" | "laura";
  text: string;
  ts: number;
}

interface BotsStatus {
  telegram: string;
  discord: string;
}

/** LAURA's sentinel mark as her chat identity. Crisp SVG at any size. */
function LauraAvatar({ className = "size-7" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/api/laura/logo"
      alt="LAURA"
      width={28}
      height={28}
      className={`border border-cyan-400/40 bg-black/60 shadow-[0_0_10px_rgba(34,211,238,0.25)] ${className}`}
    />
  );
}

const OPENER: Msg = {
  role: "laura",
  text: "LAURA here — the StonkBrokers growth swarm. Ask me about the live numbers, the products, the mission, or how the swarm is doing. This is the same brain the Discord and Telegram bots run on.",
  ts: Date.now(),
};

export function ChatPanel() {
  const [messages, setMessages] = useState<Msg[]>([OPENER]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [bots, setBots] = useState<BotsStatus | null>(null);
  const sessionId = useRef(`op-${Math.random().toString(36).slice(2, 10)}`);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/chat", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
        .then((r) => r.json())
        .then((d) => setBots((d as { bots: BotsStatus }).bots))
        .catch(() => undefined);
    const first = setTimeout(load, 0);
    const id = setInterval(load, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text, ts: Date.now() }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: sessionId.current }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      const reply = res.ok && data.reply ? data.reply : (data.error ?? "Something broke on my end — try again.");
      setMessages((m) => [...m, { role: "laura", text: reply, ts: Date.now() }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "laura", text: `Connection error: ${String(err)}`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  const tone = (s: string) =>
    s.startsWith("online")
      ? "text-[var(--sb-green)]"
      : s.startsWith("error")
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="flex flex-col lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <LauraAvatar className="size-6" /> Talk to LAURA
          </CardTitle>
          <CardDescription>
            The public persona: charter-bound, live-data-aware, never gives financial advice.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-[420px] flex-1 flex-col gap-3">
          <div className="flex-1 space-y-3 overflow-y-auto border border-border/60 bg-black/30 p-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex items-start gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                {m.role === "laura" && <LauraAvatar className="mt-0.5 size-7 shrink-0" />}
                <div
                  className={`max-w-[85%] whitespace-pre-wrap border px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "border-primary/40 bg-primary/10"
                      : "border-border/60 bg-muted/30"
                  }`}
                >
                  <span className="mb-1 block sb-ticker text-[9px] text-muted-foreground">
                    {m.role === "user" ? "YOU" : "LAURA"}
                  </span>
                  {m.text}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-start justify-start gap-2">
                <LauraAvatar className="mt-0.5 size-7 shrink-0" />
                <div className="border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  <span className="sb-blink">▋</span> thinking…
                </div>
              </div>
            )}
            <div ref={bottom} />
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                VIEWER_MODE
                  ? "View-only — chat with LAURA from Telegram or Discord instead"
                  : 'Try "stats", "mission", or "how do launches work?"'
              }
              maxLength={1000}
            />
            <Button type="submit" disabled={busy || !input.trim()}>
              <SendHorizonal className="size-3.5" /> Send
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Community connectors</CardTitle>
            <CardDescription>Users speak to this same LAURA from your servers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="flex items-center justify-between">
                <span>Telegram</span>
                <Badge variant="outline" className={`font-mono text-[10px] ${tone(bots?.telegram ?? "")}`}>
                  {bots?.telegram ?? "…"}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Create a bot with @BotFather, then set <code className="font-mono">TELEGRAM_BOT_TOKEN</code> and
                restart. DMs always answered; in groups she replies to /commands, @mentions and replies.
              </p>
            </div>
            <div className="border-t border-border/60 pt-3">
              <div className="flex items-center justify-between">
                <span>Discord</span>
                <Badge variant="outline" className={`font-mono text-[10px] ${tone(bots?.discord ?? "")}`}>
                  {bots?.discord ?? "…"}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Create an app in the Discord Developer Portal, enable the <b>Message Content</b> intent, invite
                the bot with Send Messages permission, then set <code className="font-mono">DISCORD_BOT_TOKEN</code>{" "}
                and restart. She answers DMs and @mentions only.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Public-chat guardrails</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <p>· Always identifies as an AI agent for StonkBrokers</p>
            <p>· No financial advice, price predictions or buy/sell calls</p>
            <p>· Quotes only the live numbers she is given</p>
            <p>· Never discusses wallets, keys or unpublished work</p>
            <p>· Per-user rate limit; replies only when addressed in groups</p>
            <p>· Warns users nobody legitimate asks for funds or seed phrases</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
