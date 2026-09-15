import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const MEDIA = "/home/ubuntu/laura/data/media";
const url = "https://laura.stonkbrokers.io/mcp";
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome-stable" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
const html = await page.content();
console.log("has heading:", html.includes("as one MCP server"));
console.log("has endpoint:", html.includes("/api/mcp"));
await fs.mkdir(MEDIA, { recursive: true });
const out = path.join(MEDIA, "mcp-server.png");
const png = await page.screenshot({ type: "png", fullPage: false });
await fs.writeFile(out, png);
console.log("wrote", out, Math.round(png.length / 1024), "KB");
await browser.close();
