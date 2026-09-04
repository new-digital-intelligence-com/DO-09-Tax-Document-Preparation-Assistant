import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The workspace as an MCP server.
 *
 * Claude talks to this instead of driving Google Drive through a connector, and
 * the difference is not convenience. Drive's API cannot overwrite a file's
 * contents — its update call changes a title and a parent, nothing else — so
 * every register write through the connector was read, create a replacement,
 * trash the original. Three round trips per collection, a window where two
 * files shared a name, and a write that could half-finish. Adding one receipt
 * took minutes and often left the rows unwritten.
 *
 * Here the server owns the credential and the read-modify-write happens in one
 * place, atomically, with the audit row in the same step. The tools are the
 * functions the console already calls, so both surfaces enforce one set of
 * rules in code rather than two copies of them in prose.
 *
 * ## Transport
 *
 * Streamable HTTP, stateless: one JSON-RPC request in, one response out. The
 * SDK's own `StreamableHTTPServerTransport` speaks Node's `IncomingMessage` and
 * `ServerResponse`, which a Next route handler does not have — so the tiny
 * transport below bridges the two rather than reimplementing the protocol. The
 * SDK still does the protocol work; this only carries bytes.
 *
 * A fresh server per request is deliberate. Serverless gives no guarantee that
 * two requests reach the same instance, so a long-lived session would work
 * locally and fail in production for reasons nobody could reproduce.
 */

/** Shared-secret auth. */
function authorised(request: Request): boolean {
  const expected = process.env.MCP_TOKEN?.trim();

  /*
   * No token configured means the endpoint is closed, not open.
   *
   * The alternative — treating an unset variable as "no auth needed" — turns a
   * forgotten environment variable into a public `delete_document`. Failing
   * closed makes that mistake a 503 nobody can miss instead of a breach nobody
   * notices.
   */
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  // Some clients cannot set headers; `?key=` is the fallback for those.
  const query = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  const given = bearer || query;

  if (given.length !== expected.length) return false;

  // Constant-time-ish: compare every character regardless of the first
  // mismatch, so response timing does not leak the token a byte at a time.
  let same = 0;
  for (let i = 0; i < expected.length; i += 1) {
    same |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return same === 0;
}

function unauthorised(detail: string) {
  return new Response(JSON.stringify({ error: detail }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
}

/**
 * Run one JSON-RPC message through a real MCP server and return its reply.
 *
 * The transport contract is four things — start, send, close, and an `onmessage`
 * the server calls — so satisfying it is cheaper than hand-rolling `initialize`,
 * `tools/list` and `tools/call` and getting a detail of the spec subtly wrong.
 */
async function handle(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
  const server = new McpServer(
    { name: "do-09-tax-prep", version: "1.0.0" },
    {
      instructions:
        "The tax preparation workspace. Call list_workspaces first — every figure belongs to " +
        "one person's business. Nothing here files, submits or signs a return.",
    },
  );
  registerTools(server);

  let reply: JSONRPCMessage | null = null;
  let resolveReply: (() => void) | null = null;
  const replied = new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  const transport = {
    onmessage: undefined as ((m: JSONRPCMessage) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async send(m: JSONRPCMessage) {
      reply = m;
      resolveReply?.();
    },
    async close() {
      resolveReply?.();
    },
  };

  await server.connect(transport);
  transport.onmessage?.(message);

  // A notification (no `id`) gets no response by design, so waiting on one
  // would hang the request until the platform's timeout.
  if (!("id" in message)) return null;

  await replied;
  await server.close().catch(() => undefined);
  return reply;
}

export async function POST(request: Request) {
  if (!process.env.MCP_TOKEN?.trim()) {
    return new Response(
      JSON.stringify({
        error:
          "MCP_TOKEN is not set on this deployment, so the endpoint is closed. Set it and " +
          "redeploy; the same value goes in the connector configuration.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  if (!authorised(request)) {
    return unauthorised("A valid bearer token is required to reach this workspace.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // A batch is a JSON-RPC array. Handled one at a time and reassembled, with
  // notifications contributing nothing to the reply.
  const messages = Array.isArray(body) ? body : [body];
  const replies: JSONRPCMessage[] = [];
  for (const message of messages) {
    try {
      const reply = await handle(message as JSONRPCMessage);
      if (reply) replies.push(reply);
    } catch (error) {
      replies.push({
        jsonrpc: "2.0",
        id: (message as { id?: string | number }).id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      } as JSONRPCMessage);
    }
  }

  if (replies.length === 0) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A liveness probe that never reveals whether the token is right. */
export async function GET() {
  return new Response(
    JSON.stringify({
      name: "do-09-tax-prep",
      transport: "streamable-http",
      configured: Boolean(process.env.MCP_TOKEN?.trim()),
      hint: "POST JSON-RPC here with an Authorization: Bearer <MCP_TOKEN> header.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
