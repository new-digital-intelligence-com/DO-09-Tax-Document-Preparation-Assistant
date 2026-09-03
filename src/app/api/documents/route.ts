import { documentViews, ingest, listDocuments, withdrawFromWorkspace } from "@/lib/documents";
import { processDocument } from "@/lib/workspace-sync";
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
 * Upload, read, and file it where it belongs.
 *
 * Three things happen to a file dropped on this route, in this order.
 *
 * 1. It is **uploaded to the shared Drive folder and ingested even if it
 *    duplicates one already held**. There is no local copy at any point, not
 *    even briefly — `ingest` puts the bytes straight onto Drive. Refusing a
 *    duplicate on arrival would hide that the same invoice showed up twice,
 *    and that is a finding a reviewer wants: a vendor billing twice and a
 *    folder synced twice look identical from here, and only a person can
 *    tell them apart.
 *
 * 2. It is **read and categorised immediately**, rather than left for the
 *    next sweep. Somebody who has just dropped a receipt on the page is
 *    waiting for an answer, and "it will be picked up later" is not one.
 *
 * 3. Anything that is **not a financial document is withdrawn from the
 *    shared folder** with the model's reason kept on the register row. It has
 *    to reach Drive before extraction can even look at it — there is nowhere
 *    else for the bytes to sit while that is decided — so the data-
 *    minimisation rule is honoured in reverse order here: add, then remove
 *    what turns out not to belong, rather than never adding it in the first
 *    place. A CV or a holiday photograph does not stay in the tax workspace
 *    either way.
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

      if (outcome.status === "declined") {
        await withdrawFromWorkspace(
          doc.id,
          actor,
          outcome.detail || "Not a financial document.",
        );
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
      documents: results,
      note: [
        duplicates
          ? `${duplicates} of these is byte-identical to a document already collected. Both were kept — run detection and it will be flagged.`
          : "",
        count("declined")
          ? `${count("declined")} was not a financial document and was withdrawn from the shared Drive folder rather than categorised.`
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
