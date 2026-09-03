import { overrideCategory } from "@/lib/classify";
import { preparer } from "@/lib/settings";
import { bad, body, failed, ok, requireNote, str } from "@/lib/http";

export const runtime = "nodejs";

/**
 * A human's categorisation, over the model's.
 *
 * The model's answer is kept beside it rather than replaced. Six months later
 * the useful question is not "what category is this" — the register says — but
 * "did the assistant get this wrong, and how often", and an overwrite destroys
 * the only record that could answer it.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const docId = str(payload.docId);
    const categoryId = str(payload.categoryId);
    if (!docId || !categoryId) {
      return bad("Send docId, categoryId and a note saying why the category is being changed.");
    }
    const note = requireNote(payload.note, "Changing a document's category");

    return ok(await overrideCategory({ docId, categoryId, actor: preparer(), note }));
  } catch (error) {
    if (error instanceof Error && /needs a note|not a category|must be a JSON|No extraction|no classification/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The category could not be changed.");
  }
}
