import { driveStatus } from "@/lib/drive";
import { publishToDrive } from "@/lib/workspace-sync";
import { preparer } from "@/lib/settings";
import { bad, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Upload what this workspace already holds, without re-reading any of it.
 *
 * The one-time move after connecting Drive to a corpus that was collected
 * before it. Safe to run again: documents already in the folder are recognised
 * by hash and not uploaded twice.
 */
export async function POST() {
  const status = driveStatus();
  if (status.state !== "ready") return bad(status.detail, 503);

  try {
    return ok(await publishToDrive(preparer()));
  } catch (error) {
    return failed(error, "The workspace could not be published to Drive.");
  }
}
