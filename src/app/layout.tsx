import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/* SF Pro Display — the StonkBrokers 2026 (v2 / DPP) type system. */
const sf = localFont({
  src: [
    { path: "../../public/fonts/sf/sfprodisplayregular.otf", weight: "400", style: "normal" },
    { path: "../../public/fonts/sf/sfprodisplaymedium.otf", weight: "500", style: "normal" },
    { path: "../../public/fonts/sf/sfprodisplaybold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-sf",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#0d0b11",
};

export const metadata: Metadata = {
  title: "LAURA · Layered Autonomous Unified Reasoning Agents · StonkBrokers growth swarm",
  description:
    "Operator terminal for LAURA (Layered Autonomous Unified Reasoning Agents), the self-improving StonkBrokers growth swarm: daily grader, live actions, agent roster, review queue and strategy evolution.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sf.variable} ${jetbrains.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
