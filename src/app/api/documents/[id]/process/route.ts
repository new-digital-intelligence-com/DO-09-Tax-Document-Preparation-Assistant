import { withdrawFromWorkspace } from "@/lib/documents";
import { processDocument } from "@/lib/workspace-sync";
import { preparer } from "@/lib/settings";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Read and categorise one document, on its own request.
 *
 * Split out from the upload so the upload can answer immediately. Dropping
 * five files used to mean one request that uploaded, read and categorised all
 * five before saying anything at all — a minute of a button doing nothing,
 * with no way to tell whether the files had even arrived. Now the upload
 * returns as soon as the bytes are on Drive, and the console walks the list
 * one document at a time, showing each one land.
 *
 * A document the model declines as out of scope is withdrawn from the shared
 * folder here rather than by the caller, so the same thing happens whether it
 * arrived by upload, by sweep, or by a person pressing this again later.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const actor = preparer();
    const outcome = await processDocument(id, { actor });

    if (outcome.status === "declined") {
      await withdrawFromWorkspace(id, actor, outcome.detail || "Not a financial document.");
    }

    return ok(outcome);
  } catch (error) {
    return failed(error, "The document could not be processed.");
  }
}
