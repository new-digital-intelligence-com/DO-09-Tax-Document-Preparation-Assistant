import { getDocument, removeDocument } from "@/lib/documents";
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
 * Remove a document from the workspace.
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

    await removeDocument(id, preparer(), reason);
    return ok({ removed: id, filename: doc.filename, reason });
  } catch (error) {
    if (error instanceof Error && /needs a note|must be a JSON/.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The document could not be removed.");
  }
}
