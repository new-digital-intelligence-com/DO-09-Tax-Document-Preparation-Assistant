import "server-only";
import { accountToken } from "./google-account";

/**
 * The active user's own mailbox, read through their own grant.
 *
 * Every call here goes through `accountToken()` — the person's own connection,
 * never the app's workspace token. One user can never see another's mail, and
 * the app owner's mailbox is not the fallback for anybody.
 *
 * What this reads is deliberately narrow. It looks for messages carrying
 * attachments a tax preparer would want — PDFs and scans — and it downloads
 * only the attachments a person actually picks. It never reads message bodies
 * into the register, never stores a thread, and never sweeps a mailbox on its
 * own initiative. A tax workspace is the worst possible place to accumulate
 * somebody's correspondence, and the only defence that actually holds is not
 * fetching it in the first place.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Attachment types the pipeline can actually read. Anything else is noise here. */
const WANTED = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);

export type MailAttachment = {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  /** Where it came from, for the audit trail and the source column. */
  subject: string;
  from: string;
  date?: string;
};

async function call(path: string): Promise<Response> {
  const token = await accountToken();
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const hint =
      response.status === 403
        ? " The Gmail scope may not have been granted — reconnect the account and approve mail access."
        : "";
    throw new Error(`Gmail GET ${path} failed (${response.status}).${hint} ${text.slice(0, 240)}`);
  }
  return response;
}

type Part = {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: Part[];
};

/** Walk the MIME tree. Attachments hide at any depth, not just the top level. */
function collectParts(part: Part | undefined, into: Part[]): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) into.push(part);
  for (const child of part.parts ?? []) collectParts(child, into);
}

function header(headers: { name?: string; value?: string }[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Find attachments worth importing.
 *
 * `query` is passed to Gmail's own search, so a person can narrow it the way
 * they already know how — `from:aws`, `after:2025/01/01`, a vendor name. The
 * default only adds `has:attachment`, because a message without one has
 * nothing this app can use.
 *
 * The result is a list of attachments, not of messages. One email with three
 * invoices is three importable things, and flattening it here means the
 * console can offer them individually rather than making somebody take all
 * three to get the one they want.
 */
export async function findAttachments(
  query: string,
  limit = 25,
): Promise<{ attachments: MailAttachment[]; searched: string }> {
  const searched = [query.trim(), "has:attachment"].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    q: searched,
    maxResults: String(Math.min(Math.max(limit, 1), 50)),
  });

  const list = (await (await call(`/messages?${params}`)).json()) as {
    messages?: { id: string }[];
  };
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return { attachments: [], searched };

  // Metadata for every hit at once. Sequential fetches here are the difference
  // between a search that feels instant and one that takes twenty seconds.
  const messages = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await (await call(`/messages/${id}?format=full`)).json()) as {
          id: string;
          internalDate?: string;
          payload?: Part & { headers?: { name?: string; value?: string }[] };
        };
      } catch {
        return null;
      }
    }),
  );

  const attachments: MailAttachment[] = [];
  for (const message of messages) {
    if (!message?.payload) continue;

    const headers = message.payload.headers ?? [];
    const subject = header(headers, "Subject") || "(no subject)";
    const from = header(headers, "From");
    const date = message.internalDate
      ? new Date(Number(message.internalDate)).toISOString().slice(0, 10)
      : undefined;

    const parts: Part[] = [];
    collectParts(message.payload, parts);

    for (const part of parts) {
      const mimeType = (part.mimeType ?? "").toLowerCase();
      const filename = part.filename ?? "";
      // Trust the extension when the type is generic. Plenty of mailers send a
      // PDF as application/octet-stream, and dropping those would hide exactly
      // the invoices somebody is looking for.
      const looksRight = WANTED.has(mimeType) || /\.(pdf|png|jpe?g)$/i.test(filename);
      if (!looksRight || !part.body?.attachmentId) continue;

      attachments.push({
        messageId: message.id,
        attachmentId: part.body.attachmentId,
        filename,
        mimeType: WANTED.has(mimeType) ? mimeType : guessType(filename),
        bytes: part.body.size ?? 0,
        subject,
        from,
        date,
      });
    }
  }

  return { attachments, searched };
}

function guessType(filename: string): string {
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  if (/\.png$/i.test(filename)) return "image/png";
  return "image/jpeg";
}

/** Download one attachment's bytes. Gmail returns base64url, not base64. */
export async function readAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const body = (await (
    await call(`/messages/${messageId}/attachments/${attachmentId}`)
  ).json()) as { data?: string };

  if (!body.data) throw new Error("Gmail returned no data for that attachment.");
  return Buffer.from(body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sending
 * ────────────────────────────────────────────────────────────────────────── */

export type Outgoing = {
  to: string;
  subject: string;
  /** Plain text. This app does not compose HTML mail. */
  body: string;
  cc?: string;
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
};

/**
 * Send a message from the connected person's own address.
 *
 * From their address, not the app's, and that is the point: a review package
 * arriving from a no-reply robot is a package the tax manager has no way to
 * reply to and no reason to trust. Gmail sets the From header itself from the
 * authenticated account, so there is nothing here that could spoof anybody.
 *
 * The message is assembled by hand as RFC 2822 rather than through a MIME
 * library. It is one multipart boundary and base64 attachments; a dependency
 * for that would be more surface than the thing it replaces.
 */
export async function sendMail(message: Outgoing): Promise<{ id: string; threadId: string }> {
  const token = await accountToken();
  const boundary = `do09_${Math.random().toString(36).slice(2)}`;

  const headers = [
    `To: ${message.to}`,
    message.cc ? `Cc: ${message.cc}` : "",
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    message.body,
  ];

  for (const file of message.attachments ?? []) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${file.mimeType}; name="${file.filename}"`,
      `Content-Disposition: attachment; filename="${file.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      // Wrapped at 76 characters. Some mail servers reject longer lines
      // outright, and a rejected package is worse than a slow one.
      file.content.toString("base64").replace(/(.{76})/g, "$1\r\n"),
    );
  }
  parts.push(`--${boundary}--`, "");

  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const response = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const hint =
      response.status === 403
        ? " The send scope may not have been granted — reconnect the account and approve sending."
        : "";
    throw new Error(`Gmail would not send the message (${response.status}).${hint} ${text.slice(0, 240)}`);
  }

  return (await response.json()) as { id: string; threadId: string };
}

/** Non-ASCII subjects have to be encoded or they arrive as mojibake. */
function encodeHeader(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
