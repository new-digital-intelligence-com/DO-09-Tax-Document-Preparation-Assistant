import { ingest } from "@/lib/documents";
import {
  accountConnection,
  personalFileMeta,
  readPersonalFile,
  searchPersonalDrive,
} from "@/lib/google-account";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, body, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Refuse with a status the caller can act on.
 *
 * "No account is connected" and "Drive threw" are both failures, but only one
 * of them is this app's fault and only one of them the person can fix. A 500
 * for the first tells the console something broke, when what actually happened
 * is that a step has not been taken yet — so the dialog would show an error
 * where it should be showing a Connect button.
 */
async function unconnected() {
  const connection = await accountConnection();
  if (connection.blocked) return bad(connection.blocked, 409);
  if (!connection.connected) {
    return bad(
      "No Google account is connected to this workspace. Connect one from Add documents — only " +
        "the Drive files you pick are ever read.",
      409,
    );
  }
  if (!connection.can.driveImport) {
    return bad(
      `${connection.email ?? "That account"} is connected but was not granted permission to read ` +
        "its Drive. Connect again and approve file access.",
      409,
    );
  }
  return null;
}

/** What is in the connected person's own Drive that could be imported. */
export async function GET(request: Request) {
  try {
    const refusal = await unconnected();
    if (refusal) return refusal;

    const query = new URL(request.url).searchParams.get("q") ?? "";
    return ok({ files: await searchPersonalDrive(query) });
  } catch (error) {
    return failed(error, "That Drive could not be searched.");
  }
}

/**
 * Copy chosen files out of the person's own Drive and into the workspace.
 *
 * A copy, not a link. The workspace has to hold the bytes it was told to
 * prepare a return from: a reference into somebody's personal Drive breaks the
 * moment they move the file, rename it or revoke access, and a tax package
 * that cannot produce the document behind a figure is not a package.
 *
 * Nothing is read on arrival. Ingested files come back with their ids and the
 * console walks them through `/api/documents/[id]/process` one at a time, the
 * same as an upload — so the same visible progress happens whichever way a
 * document got here.
 */
export async function POST(request: Request) {
  try {
    const refusal = await unconnected();
    if (refusal) return refusal;

    const payload = await body(request);
    const ids = Array.isArray(payload.fileIds) ? payload.fileIds.filter((v): v is string => typeof v === "string") : [];
    if (ids.length === 0) return bad("Send fileIds: an array of Drive file ids to import.");

    const period = await activePeriod();
    const actor = preparer();

    const documents = [];
    const failures: { fileId: string; error: string }[] = [];

    for (const fileId of ids) {
      try {
        const [meta, bytes] = await Promise.all([
          personalFileMeta(fileId),
          readPersonalFile(fileId),
        ]);
        const { doc, duplicateOf } = await ingest({
          filename: meta.name || `${fileId}.pdf`,
          bytes,
          mimeType: meta.mimeType || "application/pdf",
          source: "drive",
          sourceDetail: meta.from ? `Google Drive · ${meta.from}` : "Google Drive",
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
        // One unreadable file does not cancel the rest of the import. The
        // person picked several things; failing all of them because of one is
        // worse than telling them which one did not come across.
        failures.push({
          fileId,
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
    return failed(error, "The import from Drive failed.");
  }
}
