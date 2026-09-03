import { getDocument, readDocumentBytes } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * The file itself, for the viewer in the document drawer.
 *
 * Served inline rather than as a download: a reviewer checking an extracted
 * total against the page needs both on screen at once, and a browser that
 * saves the file instead has made them leave the screen to answer the
 * question they were on.
 *
 * `readDocumentBytes` fetches straight from the Drive `input` folder — there
 * is no local copy to try first. That is what makes the shared workspace
 * actually shared: a document another run, or a Claude session, put on Drive
 * previews here without this machine ever having downloaded it before.
 *
 * A document Drive cannot produce is reported as exactly that. A blank
 * preview pane with no explanation reads as a corrupt document, which is a
 * different problem from a missing one and sends the reviewer looking in the
 * wrong place.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) {
    return new Response(`No document with id ${id} is on the register.`, { status: 404 });
  }

  try {
    const bytes = await readDocumentBytes(id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": doc.mimeType || "application/pdf",
        // The filename is quoted and stripped of quotes of its own: several of
        // the corpus names carry spaces and parentheses.
        "content-disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
        "cache-control": "private, max-age=3600",
        "content-length": String(bytes.length),
      },
    });
  } catch (error) {
    return new Response(
      `${doc.filename} is on the register but could not be read from the Drive input folder: ` +
        `${error instanceof Error ? error.message : "unknown error"}. Nothing has been lost from ` +
        "the register — the extracted figures are still on the document's row — but the page " +
        "itself cannot be shown until the file is reachable there again.",
      { status: 502 },
    );
  }
}
