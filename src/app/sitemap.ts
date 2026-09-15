import type { MetadataRoute } from "next";
import { MCP_SITE } from "@/lib/mcp/site";

/** Sitemap. /mcp leads: it is the page agents and their operators arrive on. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: MCP_SITE.page, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: MCP_SITE.origin, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${MCP_SITE.origin}/contracts`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: `${MCP_SITE.origin}/lab`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: MCP_SITE.llms, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
    { url: MCP_SITE.llmsFull, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
  ];
}
