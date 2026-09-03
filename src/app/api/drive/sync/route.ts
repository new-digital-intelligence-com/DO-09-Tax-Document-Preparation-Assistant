import { driveStatus } from "@/lib/drive";
import { syncFromDrive } from "@/lib/workspace-sync";
import { preparer } from "@/lib/settings";
import { bad, failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Pull anything new out of the Drive input folder.
 *
 * Collection only: it downloads and registers documents, and reads none of
 * them. Separating the sweep from the reading means a folder that has grown by
 * one file does not cost a full pass over the corpus to notice.
 */
export async function POST() {
  const status = driveStatus();
  if (status.state !== "ready") return bad(status.detail, 503);

  try {
    return ok(await syncFromDrive(preparer()));
  } catch (error) {
    return failed(error, "The Drive input folder could not be swept.");
  }
}
