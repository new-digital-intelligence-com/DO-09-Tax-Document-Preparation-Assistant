import { getDocument } from "@/lib/documents";
import { purgeDocument } from "@/lib/workspace-sync";
import { getExtraction } from "@/lib/extract";
import { getClassification } from "@/lib/classify";
import { listExceptions } from "@/lib/exceptions";
import { preparer } from "@/lib/settings";
import { bad, body, failed, ok, requireNote } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return bad(`No document with id ${id}.`, 404);

    const [extraction, classification, exceptions] = await Promise.all([
      getExtraction(id),
      getClassification(id),
      listExceptions({ docId: id }),
    ]);
    return ok({ doc, extraction, classification, exceptions });
  } catch (error) {
    return failed(error, "The document could not be read.");
  }
}

/**
 * Remove a document and everything held because of it.
 *
 * `purgeDocument` rather than `removeDocument`: the register row, the reading,
 * the categorisation, the findings raised about it, the file in `input/` and
 * the cached result in `output/` all go. The cache is the one that decides
 * whether the deletion holds — left behind, it restores the old figures the
 * moment the same file is uploaded again.
 *
 * The reason is required and written to the trail. A document that vanishes
 * from a filing period with no record of who removed it or why is the one gap
 * an audit cannot be reconstructed across.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = await body(request);
    const reason = requireNote(payload.reason, "Removing a document from the period");

    const doc = await getDocument(id);
    if (!doc) return bad(`No document with id ${id}.`, 404);

    const removed = await purgeDocument(id, preparer(), reason);
    return ok({
      removed: removed.id,
      filename: removed.filename,
      cacheCleared: removed.cacheCleared,
      reason,
      note:
        `${removed.filename} is gone: its row, its reading, its categorisation and any finding ` +
        `raised only about it, plus the file on Drive` +
        (removed.cacheCleared ? " and its cached reading." : "."),
    });
  } catch (error) {
    if (error instanceof Error && /needs a note|must be a JSON/.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The document could not be removed.");
  }
}
