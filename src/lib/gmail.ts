import "server-only";
import { accountToken } from "./google-account";

/**
 * Sending mail as the connected person, and nothing else.
 *
 * This module can send. It cannot read: there is no search, no message fetch,
 * no attachment download, and the grant behind it does not carry a read scope
 * at all. That is worth stating because the obvious next feature — pulling
 * invoices out of somebody's inbox — was built here and then deliberately
 * removed. A tax workspace is a bad place to accumulate correspondence, and
 * the only defence that actually holds is not having the permission.
 *
 * The one call below goes through `accountToken()` — the person's own
 * connection, never the app's workspace token — so a package goes out from the
 * address of whoever prepared it.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

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
