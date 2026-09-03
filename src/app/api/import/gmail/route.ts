import { ingest } from "@/lib/documents";
import { findAttachments, readAttachment } from "@/lib/gmail";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, body, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Attachments in the connected person's own mailbox that could be imported.
 *
 * The query goes straight to Gmail's own search, so `from:aws`,
 * `after:2025/01/01` and a plain vendor name all work the way somebody already
 * expects them to. Only messages with attachments are considered, and only
 * PDFs and scans are listed — a picker that offered every signature image and
 * inline logo would bury the invoices somebody came for.
 */
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return ok(await findAttachments(query));
  } catch (error) {
    return failed(error, "That mailbox could not be searched.");
  }
}

/**
 * Pull chosen attachments into the workspace.
 *
 * Only what was picked. This never sweeps a mailbox on its own initiative and
 * never stores a message body — a tax workspace accumulating somebody's
 * correspondence is a much larger collection than preparing a quarter needs,
 * and the only defence that holds is not fetching it.
 *
 * The sending address and subject travel with each document as its source, so
 * a reviewer looking at a figure months later can see which email it arrived
 * on without going back to the mailbox.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const picks = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (picks.length === 0) {
      return bad("Send attachments: an array of { messageId, attachmentId, filename, mimeType, from, subject }.");
    }

    const period = await activePeriod();
    const actor = preparer();

    const documents = [];
    const failures: { filename: string; error: string }[] = [];

    for (const pick of picks) {
      const item = pick as Record<string, unknown>;
      const messageId = typeof item.messageId === "string" ? item.messageId : "";
      const attachmentId = typeof item.attachmentId === "string" ? item.attachmentId : "";
      const filename = typeof item.filename === "string" && item.filename ? item.filename : "attachment.pdf";

      if (!messageId || !attachmentId) {
        failures.push({ filename, error: "Missing the message or attachment id." });
        continue;
      }

      try {
        const bytes = await readAttachment(messageId, attachmentId);
        const from = typeof item.from === "string" ? item.from : "";
        const subject = typeof item.subject === "string" ? item.subject : "";
        const { doc, duplicateOf } = await ingest({
          filename,
          bytes,
          mimeType: typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "application/pdf",
          source: "gmail",
          sourceDetail: [from, subject].filter(Boolean).join(" — ").slice(0, 200) || "Gmail",
          periodId: period.id,
          actor,
        });
        documents.push({
          id: doc.id,
          filename: doc.filename,
          bytes: doc.bytes,
          duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : undefined,
        });
      } catch (cause) {
        // One attachment that will not download does not cancel the others.
        failures.push({
          filename,
          error: cause instanceof Error ? cause.message : "Could not be imported.",
        });
      }
    }

    const duplicates = documents.filter((row) => row.duplicateOf).length;
    return ok({
      ingested: documents.length,
      duplicates,
      documents,
      failures,
      note:
        [
          duplicates
            ? `${duplicates} of these is byte-identical to a document already collected. Both were kept — the second arrival is itself the finding.`
            : "",
          failures.length ? `${failures.length} could not be imported.` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    });
  } catch (error) {
    return failed(error, "The import from Gmail failed.");
  }
}
