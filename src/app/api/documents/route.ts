import { documentViews, ingest } from "@/lib/documents";
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
 * Upload, and answer as soon as the bytes are safe.
 *
 * This route does NOT read or categorise anything. That is deliberate, and it
 * is the difference between an upload that shows you something and one that
 * appears to hang: reading five documents is five model calls, the better
 * part of a minute, and a single request that did all of it before replying
 * left a person staring at a button with no idea whether their files had even
 * arrived. Now the answer comes back the moment each file is on Drive, and
 * the console walks the returned ids through `/api/documents/[id]/process`
 * one at a time, showing each document land as it goes.
 *
 * A duplicate is ingested rather than refused. Refusing it would hide that
 * the same invoice showed up twice, and that is a finding a reviewer wants: a
 * vendor billing twice and a folder synced twice look identical from here,
 * and only a person can tell them apart.
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

    const documents = [];
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
      documents.push({
        id: doc.id,
        filename: doc.filename,
        bytes: doc.bytes,
        duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : undefined,
      });
    }

    const duplicates = documents.filter((row) => row.duplicateOf).length;

    return ok({
      ingested: documents.length,
      duplicates,
      documents,
      note: duplicates
        ? `${duplicates} of these is byte-identical to a document already collected. Both were kept — the second arrival is itself the finding.`
        : undefined,
    });
  } catch (error) {
    return failed(error, "The upload could not be stored.");
  }
}
