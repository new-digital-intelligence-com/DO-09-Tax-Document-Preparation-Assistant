import { driveEnv, driveStatus, listFolder, workspace } from "@/lib/drive";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Whether the workspace is reachable, and what is in it.
 *
 * Three states, never two. "Not configured", "configured but nobody has
 * consented" and "connected" need three different actions from the operator,
 * and collapsing them into a boolean sends them to fix the wrong one.
 */
export async function GET() {
  const status = driveStatus();
  const env = driveEnv();

  if (status.state !== "ready") {
    return ok({
      ...status,
      folderId: env.folderId || null,
      folderUrl: env.folderId ? `https://drive.google.com/drive/folders/${env.folderId}` : null,
      connectUrl: status.state === "needs-consent" ? "/api/drive/connect" : null,
      input: null,
      output: null,
    });
  }

  try {
    const folders = await workspace();
    const [input, output] = await Promise.all([
      listFolder(folders.inputId),
      listFolder(folders.outputId),
    ]);

    return ok({
      ...status,
      folderId: env.folderId,
      folderUrl: `https://drive.google.com/drive/folders/${env.folderId}`,
      connectUrl: null,
      input: { id: folders.inputId, count: input.length, files: input.slice(0, 200) },
      output: { id: folders.outputId, count: output.length },
    });
  } catch (error) {
    // A reachable-but-failing Drive is an outage to report, never an empty
    // folder to present as a finding.
    return failed(error, "The workspace folder could not be read.");
  }
}
