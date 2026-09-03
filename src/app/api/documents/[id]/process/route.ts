import { withdrawFromWorkspace } from "@/lib/documents";
import { processDocument, type ProcessStep } from "@/lib/workspace-sync";
import { preparer } from "@/lib/settings";
import { failed } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Read and categorise one document, reporting each step as it happens.
 *
 * The response is a stream of NDJSON — one JSON object per line — rather than
 * a single answer at the end. That is the whole point of this route existing.
 * Processing a document is four network round trips and the better part of
 * half a minute; a request that stayed silent for all of it and then returned
 * a verdict left a person with no way to tell a working upload from a broken
 * one. Somebody who cannot see anything happening goes looking for their file,
 * uploads it a second time, or concludes the app is stuck.
 *
 * Each line is a `ProcessStep` — checking the cache, reading the page, what
 * was read off it, the category it landed in, saving the answer back — and the
 * last line carries the finished outcome under `outcome`. The console renders
 * them as they arrive.
 *
 * `Content-Encoding: none` and the `X-Accel-Buffering` header are not
 * decoration: without them a proxy or the dev server will happily buffer the
 * whole stream and deliver it in one piece at the end, which is exactly the
 * behaviour this route was written to stop.
 *
 * A document the model declines as out of scope is withdrawn from the shared
 * folder here rather than by the caller, so the same thing happens whether it
 * arrived by upload, by sweep, or by a person pressing this again later.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const actor = preparer();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (value: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };

        try {
          const outcome = await processDocument(id, {
            actor,
            onStep: (step: ProcessStep) => send({ type: "step", ...step }),
          });

          if (outcome.status === "declined") {
            send({
              type: "step",
              stage: "declined",
              label: "Removing it from the workspace",
              detail: "A document that is not a financial record does not stay in the shared folder.",
            });
            await withdrawFromWorkspace(id, actor, outcome.detail || "Not a financial document.");
          }

          send({ type: "outcome", outcome });
        } catch (error) {
          // The stream has already started, so the status code is spent. The
          // error has to travel as a line like everything else, and the client
          // reads the absence of an `outcome` line as a failure.
          send({
            type: "error",
            error: error instanceof Error ? error.message : "The document could not be processed.",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "content-encoding": "none",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return failed(error, "The document could not be processed.");
  }
}
