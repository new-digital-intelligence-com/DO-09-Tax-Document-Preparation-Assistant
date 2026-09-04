import { ingest } from "@/lib/documents";
import { readUploadTicket } from "@/lib/mcp/upload-token";
import { activePeriod, preparer } from "@/lib/settings";
import { withWorkspace } from "@/lib/workspace-context";
import { processDocument } from "@/lib/workspace-sync";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Where a file's bytes arrive, straight from wherever they already are.
 *
 * A model cannot carry bytes. It can run `base64` on a path in its sandbox, but
 * the output lands in a terminal buffer and moving it into a tool argument
 * means retyping thousands of tokens — which in practice does not happen: the
 * command runs, the result goes nowhere, and the tool is called with the
 * content field empty. Three minutes to upload nothing.
 *
 * So the model asks for a ticket and runs one command:
 *
 *     curl -X PUT --data-binary @<path> "<uploadUrl>"
 *
 * and the file goes from its sandbox to here without passing through the
 * conversation at all. What comes back is the finished result — registered,
 * read, categorised — so the upload and its answer are a single round trip.
 *
 * The ticket carries its own authorisation, signed with `MCP_TOKEN`. That is
 * what lets this route be reachable without a bearer header, which it must be:
 * a plain `curl -T` is the only shape that works from every sandbox.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let ticket;
  try {
    ticket = readUploadTicket(token);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "That upload ticket is not valid." },
      { status: 401 },
    );
  }

  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length === 0) {
      return Response.json(
        {
          error:
            "The upload was empty. Check the path in the curl command — `--data-binary @<path>` " +
            "with a missing file sends nothing rather than failing.",
        },
        { status: 400 },
      );
    }

    // The ticket names the workspace, so this route needs no cookie and no
    // ambient state — the same reason the MCP tools carry one.
    return await withWorkspace(ticket.workspaceId, async () => {
      const period = await activePeriod();
      const actor = preparer();

      const { doc, duplicateOf } = await ingest({
        filename: ticket.filename,
        bytes,
        mimeType: ticket.mimeType,
        source: "upload",
        sourceDetail: "Added through Claude",
        periodId: period.id,
        actor,
      });

      const outcome = await processDocument(doc.id, { actor });

      return Response.json({
        added: true,
        document: { id: doc.id, filename: doc.filename, bytes: doc.bytes, sha256: doc.sha256 },
        duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : null,
        read: outcome,
      });
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The upload could not be stored." },
      { status: 500 },
    );
  }
}

/** POST behaves identically, because some clients cannot send PUT. */
export const POST = PUT;
