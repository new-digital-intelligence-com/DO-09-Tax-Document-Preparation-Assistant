import { driveStatus } from "@/lib/drive";
import { runPeriod } from "@/lib/workspace-sync";
import { listDocuments } from "@/lib/documents";
import { listExtractions } from "@/lib/extract";
import { activePeriod, preparer } from "@/lib/settings";
import { modelConfigured } from "@/lib/anthropic";
import { body, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * What a run would do, before doing it.
 *
 * The panel renders from this on load, so the operator sees the state of the
 * workspace without paying for a sweep to find out.
 */
export async function GET() {
  try {
    const period = await activePeriod();
    const [docs, extractions] = await Promise.all([
      listDocuments({ periodId: period.id }),
      listExtractions(period.id),
    ]);
    const read = new Set(extractions.map((row) => row.docId));

    return ok({
      period,
      drive: driveStatus(),
      modelConfigured: modelConfigured(),
      counts: {
        documents: docs.length,
        processed: docs.filter((doc) => read.has(doc.id)).length,
        pending: docs.filter((doc) => !read.has(doc.id)).length,
      },
    });
  } catch (error) {
    return failed(error, "The workspace could not be read.");
  }
}

/**
 * Sweep the Drive input folder, then work through the period.
 *
 * The response lists every document with what happened to it, including the
 * ones nothing happened to. That is deliberate: the whole value of the result
 * cache is that a second run is nearly free, and a response that only mentioned
 * the documents it re-read would make that impossible to see. "Reused" is the
 * line the operator is looking for.
 *
 * `force` ignores the cache. It exists for the case where the prompt or the
 * category chart changed and a stored answer is stale in a way the file's hash
 * cannot see — never as a default, because a run that silently re-read
 * everything is indistinguishable from a cache that does not work.
 */
export async function POST(request: Request) {
  if (!modelConfigured()) {
    return ok(
      {
        error:
          "ANTHROPIC_API_KEY is not set, so no document can be read. Nothing was attempted — a " +
          "run that failed on every document would leave the corpus looking half-processed.",
      },
      503,
    );
  }

  try {
    const payload = await body(request).catch(() => ({}) as Record<string, unknown>);
    return ok(await runPeriod({ force: payload.force === true, actor: preparer() }));
  } catch (error) {
    return failed(error, "The run failed.");
  }
}
