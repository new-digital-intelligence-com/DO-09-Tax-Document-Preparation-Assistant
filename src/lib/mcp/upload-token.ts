import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived ticket authorising one file upload.
 *
 * The reason this exists is that a model cannot carry a file's bytes. It can
 * run `base64` on a path in its sandbox, but the output lands in a terminal
 * buffer, and getting it into a tool argument means retyping every one of those
 * thousands of tokens by hand. In practice it does not: it runs the command,
 * fails to move the result, and sends the call with the content field missing —
 * three minutes spent to upload nothing.
 *
 * So the bytes never go near the model. It asks for a ticket, runs one `curl`
 * that streams the file from its sandbox straight to this server, and reads the
 * result. The transfer is a pipe between two machines that are good at moving
 * bytes, and the model's only job is to name the file.
 *
 * The ticket is signed rather than stored because the server is serverless:
 * there is no shared memory between the request that mints one and the request
 * that redeems it. Everything needed to verify it travels inside it.
 */

type Ticket = { workspaceId: string; filename: string; mimeType: string; expiresAt: number };

/** Ten minutes: long enough for a slow upload, short enough that a leaked URL dies. */
const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const value = process.env.MCP_TOKEN?.trim();
  if (!value) throw new Error("MCP_TOKEN is not set, so upload tickets cannot be signed.");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function mintUploadTicket(input: Omit<Ticket, "expiresAt">): string {
  const ticket: Ticket = { ...input, expiresAt: Date.now() + TTL_MS };
  const payload = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify and unpack a ticket, or explain precisely why it is no good.
 *
 * The two failures are told apart on purpose: an expired ticket means ask for
 * another, a bad signature means something is wrong that retrying will not fix.
 */
export function readUploadTicket(token: string): Ticket {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("That upload ticket is malformed.");

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error("That upload ticket is not valid for this server.");
  }

  const ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Ticket;
  if (Date.now() > ticket.expiresAt) {
    throw new Error("That upload ticket has expired. Request another and retry.");
  }
  return ticket;
}
