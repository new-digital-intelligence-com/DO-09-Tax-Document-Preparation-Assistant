import { driveStatus } from "@/lib/drive";
import { pruneLocalDocuments } from "@/lib/workspace-sync";
import { preparer } from "@/lib/settings";
import { bad, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Free the local copies of documents Drive already holds.
 *
 * Each one is verified against Drive by hash before it is deleted, so a
 * document Drive does not have keeps its only copy here.
 */
export async function POST() {
  const status = driveStatus();
  if (status.state !== "ready") return bad(status.detail, 503);

  try {
    return ok(await pruneLocalDocuments(preparer()));
  } catch (error) {
    return failed(error, "The local copies could not be pruned.");
  }
}
