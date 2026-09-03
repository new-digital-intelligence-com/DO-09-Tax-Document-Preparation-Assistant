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
      // The link goes to THIS user's folder, never the shared root. The root
      // lists every workspace on the instance, and sending somebody there to
      // look at their own documents shows them everybody else's folder names.
      folderUrl: `https://drive.google.com/drive/folders/${folders.userFolderId}`,
      rootUrl: `https://drive.google.com/drive/folders/${env.folderId}`,
      userFolderName: folders.userFolderName,
      connectUrl: null,
      input: { id: folders.inputId, count: input.length, files: input.slice(0, 200) },
      output: { id: folders.outputId, count: output.length },
    });
  } catch (error) {
    /*
     * "Nobody has picked a workspace yet" is not an outage.
     *
     * Drive is configured and reachable in that state; what is missing is a
     * choice the person has not made. Reporting it as a 500 puts an app that
     * is working perfectly into the same bucket as one whose credentials have
     * expired, and sends whoever is debugging to look at Google rather than at
     * the front screen. It is the ordinary state of every fresh browser.
     *
     * Everything else here genuinely is an outage: a reachable-but-failing
     * Drive is a fault to report, never an empty folder to present as a
     * finding.
     */
    const message = error instanceof Error ? error.message : "";
    if (/No user is selected/i.test(message)) {
      return ok({
        ...status,
        state: "needs-workspace" as const,
        detail: message,
        folderId: env.folderId,
        folderUrl: null,
        rootUrl: `https://drive.google.com/drive/folders/${env.folderId}`,
        connectUrl: null,
        input: null,
        output: null,
      });
    }
    return failed(error, "The workspace folder could not be read.");
  }
}
