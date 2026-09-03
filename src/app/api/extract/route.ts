import { extractDocument, extractPending, listExtractions } from "@/lib/extract";
import { activePeriod, preparer } from "@/lib/settings";
import { modelConfigured } from "@/lib/anthropic";
import { bad, body, failed, num, ok, str } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  try {
    const period = await activePeriod();
    return ok({ extractions: await listExtractions(period.id) });
  } catch (error) {
    return failed(error, "The extractions could not be read.");
  }
}

/**
 * Read the documents.
 *
 * Refuses up front when no key is configured rather than failing per document:
 * thirty-nine identical auth errors tell the operator the same thing once, and
 * a partial run leaves a corpus where "not extracted" and "unreadable" are
 * mixed together.
 */
export async function POST(request: Request) {
  if (!modelConfigured()) {
    return bad(
      "ANTHROPIC_API_KEY is not set, so no document can be read. Nothing was attempted — a run " +
        "that failed on every document would leave the corpus looking half-read.",
      503,
    );
  }

  try {
    const payload = await body(request).catch(() => ({}) as Record<string, unknown>);
    const period = await activePeriod();
    const actor = preparer();

    const docId = str(payload.docId);
    if (docId) {
      return ok({ run: 1, results: [await extractDocument(docId, actor)] });
    }

    return ok(await extractPending(period.id, actor, num(payload.limit)));
  } catch (error) {
    return failed(error, "The extraction run failed.");
  }
}
