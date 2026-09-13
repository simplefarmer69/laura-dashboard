import { NextResponse, type NextRequest } from "next/server";
import { handleMcpBody, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION, mcpToolCatalogue } from "@/lib/mcp/server";

/**
 * MCP endpoint (Streamable HTTP, stateless). Point any MCP client at
 * POST https://laura.stonkbrokers.io/api/mcp - see docs/MCP.md.
 *
 * GET answers with a JSON description instead of an SSE stream: this server
 * pushes no server-initiated messages, so there is nothing to stream, and
 * the description doubles as a discovery card for agents that land here by
 * URL. The route is public and read only; see src/lib/mcp/server.ts for the
 * boundaries.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-expose-headers": "mcp-protocol-version",
};

const MAX_BODY_BYTES = 64 * 1024;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  return NextResponse.json(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: "streamable-http (stateless, POST JSON-RPC 2.0)",
      endpoint: `${origin}/api/mcp`,
      manifest: `${origin}/api/agents/manifest`,
      docs: `${origin}/for-agents.md`,
      tools: mcpToolCatalogue(),
      note: "Read only. Nothing here signs, spends, launches or posts.",
    },
    { headers: { ...CORS, "cache-control": "public, s-maxage=60" } },
  );
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES)
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } }, { status: 413, headers: CORS });

  const { status, body } = await handleMcpBody(raw);
  const headers = { ...CORS, "mcp-protocol-version": MCP_PROTOCOL_VERSION, "cache-control": "no-store" };
  if (body === null) return new Response(null, { status, headers });
  return NextResponse.json(body, { status, headers });
}
