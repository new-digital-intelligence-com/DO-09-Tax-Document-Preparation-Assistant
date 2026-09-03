import { documentViews, ingest, listDocuments } from "@/lib/documents";
import { driveStatus } from "@/lib/drive";
import { processDocument, pushDocumentToDrive } from "@/lib/workspace-sync";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 600;

/** The period's corpus, joined with whatever has been read off each document. */
export async function GET() {
  try {
    const period = await activePeriod();
    return ok({ period, documents: await documentViews(period.id) });
  } catch (error) {
    return failed(error, "The documents could not be read.");
  }
}

/**
 * Upload, read, and put it where the next run will find it.
 *
 * Four things happen to a file dropped on this route, in this order, and the
 * order is the design.
 *
 * 1. It is **ingested even if it duplicates one already held**. Refusing the
 *    second copy would hide that the same invoice arrived twice, and that is a
 *    finding a reviewer wants: a vendor billing twice and a folder synced twice
 *    look identical from here, and only a person can tell them apart.
 *
 * 2. It is **read and categorised immediately**, rather than left for the next
 *    sweep. Somebody who has just dropped a receipt on the page is waiting for
 *    an answer, and "it will be picked up later" is not one.
 *
 * 3. Anything that is **not a financial document is declined** with the reason
 *    the model gave. People upload whatever they have, and a CV forced onto the
 *    chart of tax categories is worse than a CV turned away.
 *
 * 4. Only what succeeded is **pushed to the shared Drive folder**. A declined
 *    document is never uploaded: that folder is the tax workspace, and putting
 *    somebody's holiday photograph in it because they dropped it on this page
 *    is exactly the data-minimisation failure the operating rules warn about.
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return bad('Attach at least one file under the form field "file".');
    }

    const period = await activePeriod();
    const actor = preparer();
    const driveReady = driveStatus().state === "ready";
    const before = (await listDocuments({ periodId: period.id })).length;

    type UploadResult = {
      id: string;
      filename: string;
      bytes: number;
      status: string;
      detail: string;
      vendor?: string;
      total?: number;
      currency?: string;
      categoryId?: string;
      storedToDrive: boolean;
      driveDetail: string;
      duplicateOf?: { id: string; filename: string };
    };
    const results: UploadResult[] = [];

    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      const { doc, duplicateOf } = await ingest({
        filename: file.name,
        bytes,
        mimeType: file.type || "application/pdf",
        source: "upload",
        sourceDetail: actor,
        periodId: period.id,
        actor,
      });

      const outcome = await processDocument(doc.id, { actor });

      // The push is conditional on the document being something this workspace
      // should hold, not merely on the run not crashing.
      let drive = { stored: false, detail: "Drive is not connected." };
      if (driveReady && (outcome.status === "computed" || outcome.status === "reused")) {
        try {
          drive = await pushDocumentToDrive(doc.id);
        } catch (error) {
          drive = {
            stored: false,
            detail: `Processed, but could not be added to Drive: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          };
        }
      } else if (driveReady && outcome.status === "declined") {
        drive = {
          stored: false,
          detail: "Not added to the shared folder, because it is not a financial document.",
        };
      }

      results.push({
        id: doc.id,
        filename: doc.filename,
        bytes: doc.bytes,
        status: outcome.status,
        detail: outcome.detail,
        vendor: outcome.vendor,
        total: outcome.total,
        currency: outcome.currency,
        categoryId: outcome.categoryId,
        storedToDrive: drive.stored,
        driveDetail: drive.detail,
        duplicateOf: duplicateOf
          ? { id: duplicateOf.id, filename: duplicateOf.filename }
          : undefined,
      });
    }

    const count = (status: string) => results.filter((r) => r.status === status).length;
    const duplicates = results.filter((r) => r.duplicateOf).length;

    return ok({
      ingested: results.length,
      before,
      computed: count("computed"),
      reused: count("reused"),
      declined: count("declined"),
      failed: count("failed"),
      duplicates,
      storedToDrive: results.filter((r) => r.storedToDrive).length,
      documents: results,
      note: [
        duplicates
          ? `${duplicates} of these is byte-identical to a document already collected. Both were kept — run detection and it will be flagged.`
          : "",
        count("declined")
          ? `${count("declined")} was not a financial document and was declined rather than categorised. It is not on the shared folder.`
          : "",
        count("reused")
          ? `${count("reused")} had already been processed, so the stored result was reused rather than paid for again.`
          : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    });
  } catch (error) {
    return failed(error, "The upload could not be stored.");
  }
}
