import { getDocument, readDocumentBytes } from "@/lib/documents";
import { downloadFile, driveStatus, findInFolder, workspace } from "@/lib/drive";

export const runtime = "nodejs";

/**
 * The file itself, for the viewer in the document drawer.
 *
 * Served inline rather than as a download: a reviewer checking an extracted
 * total against the page needs both on screen at once, and a browser that saves
 * the file instead has made them leave the screen to answer the question they
 * were on.
 *
 * Two places hold the bytes, and this route tries both. The local copy under
 * `.data/documents/` is the fast path. The Drive `input` folder is the fallback,
 * and it is what makes the shared workspace actually shared: a document another
 * run — or a Claude session — put on Drive can be previewed here without this
 * machine ever having downloaded it, and a cleared `.data/` directory costs a
 * round trip rather than a broken viewer.
 *
 * A document present in neither is reported as exactly that. A blank preview
 * pane with no explanation reads as a corrupt document, which is a different
 * problem from a missing one and sends the reviewer looking in the wrong place.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) {
    return new Response(`No document with id ${id} is on the register.`, { status: 404 });
  }

  const headers = {
    "content-type": doc.mimeType || "application/pdf",
    // The filename is quoted and stripped of quotes of its own: several of the
    // corpus names carry spaces and parentheses.
    "content-disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
    "cache-control": "private, max-age=3600",
  };

  // 1. The local copy.
  try {
    const bytes = await readDocumentBytes(id);
    return new Response(new Uint8Array(bytes), {
      headers: { ...headers, "content-length": String(bytes.length) },
    });
  } catch {
    // Fall through. A missing local file is ordinary on a workspace whose
    // corpus was collected by another run.
  }

  // 2. Drive, if it is connected.
  if (driveStatus().state === "ready") {
    try {
      const bytes = await fromDrive(doc.sourceRef, doc.filename);
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: { ...headers, "content-length": String(bytes.length), "x-do09-source": "drive" },
        });
      }
    } catch (error) {
      return new Response(
        `${doc.filename} is on the register but could not be read from Drive: ` +
          `${error instanceof Error ? error.message : "unknown error"}. This is a connection ` +
          `problem, not a problem with the document.`,
        { status: 502 },
      );
    }
  }

  return new Response(
    `${doc.filename} is on the register but its file is in neither the local workspace nor the ` +
      `Drive input folder. It was recorded at ${doc.storagePath}. Nothing has been lost from the ` +
      `register — the extracted figures are still on the document's row — but the page itself ` +
      `cannot be shown until the file is put back.`,
    { status: 410 },
  );
}

/**
 * The bytes from Drive, by id first and by name second.
 *
 * `sourceRef` holds the Drive file id for anything collected by the sweep, and
 * that is the reliable route. Falling back to a name lookup covers a document
 * uploaded here and pushed to Drive afterwards, where the register never
 * learned the id it was given.
 */
async function fromDrive(sourceRef: string | undefined, filename: string): Promise<Buffer | null> {
  if (sourceRef) {
    try {
      return await downloadFile(sourceRef);
    } catch {
      // The id may belong to a file that was replaced on Drive; try the name.
    }
  }

  const folders = await workspace();
  const match = await findInFolder(folders.inputId, filename);
  return match ? downloadFile(match.id) : null;
}
