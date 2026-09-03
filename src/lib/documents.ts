import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { record } from "./audit";
import { documentsDir, mutate, newId, readStore } from "./store";
import type {
  Classification,
  DocumentSource,
  DocumentView,
  Extraction,
  PrepStatus,
  SourceDocument,
  TaxException,
} from "./types";

/**
 * Collection: the register of files, and the bytes behind them.
 *
 * This module holds the one record that is not derived from anything —
 * everything downstream (an extraction, a category, a match, a flag, a form
 * line) can be recomputed from a document, and a document cannot be recomputed
 * from any of them. So the row and the file are written together and removed
 * together, and neither is ever quietly replaced.
 */

/**
 * Document files live under the active user's directory, not a shared one.
 *
 * `documentsDir()` resolves it per call rather than at module load, because the
 * active user changes while the process is running and a constant captured at
 * import time would serve one person's PDFs to whoever switched in next.
 */

/**
 * The file extension is taken from the declared type rather than the filename.
 *
 * A PNG receipt stored as `.pdf` is served to the viewer with the wrong type
 * and shows as a broken frame; the model then receives a block it cannot read
 * and the document comes back `unreadable`, blaming the page for a naming
 * fault. Unknown types fall back to `.pdf` because that is what the corpus and
 * the upload route deal in.
 */
const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
};

/** Worst first, so the first flag on a document is the one that matters most. */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Where a row's bytes actually live.
 *
 * `storagePath` is read out of a JSON file on disk and `readDocumentBytes`
 * hands whatever it points at to a browser, so only the basename is trusted: a
 * hand-edited row reading `../../../etc/passwd` resolves to a file that is not
 * there rather than to one that is. It also means the seeder writing
 * `documents/doc_f01.pdf` and an uploader writing `doc_f01.pdf` land in the
 * same place, which costs one line and saves a corpus that half-loads.
 */
async function fileFor(doc: SourceDocument): Promise<string> {
  const name = path.basename(doc.storagePath ?? "");
  if (!name || name === "." || name === "..") {
    throw new Error(`${doc.id} has no usable storage path on its register row.`);
  }
  return path.join(await documentsDir(), name);
}

/**
 * A page count read off the raw bytes, or nothing.
 *
 * There is no PDF library in this app, so this counts `/Type /Page` markers —
 * a cheap estimate that is right for the born-digital invoices the corpus is
 * made of and simply absent for anything else. A PDF that stores its page tree
 * in a compressed object stream yields zero matches while being perfectly
 * valid, which is why zero returns undefined rather than 0: "we did not manage
 * to count" and "this file has no pages" are different statements, and only one
 * of them is true. Never guess a number that a reviewer might read as fact.
 */
function countPages(bytes: Buffer, mimeType: string): number | undefined {
  if (mimeType !== "application/pdf") return undefined;
  const markers = bytes.toString("latin1").match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const count = markers?.length ?? 0;
  // An implausible count means the pattern hit something that is not a page
  // object. Report nothing rather than a number nobody can explain.
  if (count === 0 || count > 5000) return undefined;
  return count;
}

export async function listDocuments(filter?: {
  periodId?: string;
  source?: DocumentSource;
}): Promise<SourceDocument[]> {
  const docs = await readStore<SourceDocument[]>("documents", []);
  return docs
    .filter((doc) => {
      if (filter?.periodId && doc.periodId !== filter.periodId) return false;
      if (filter?.source && doc.source !== filter.source) return false;
      return true;
    })
    /**
     * Collection order, not recency. The package's document index is built from
     * this list, and the corpus is ingested in a fixed order, so a package
     * assembled twice from the same corpus reads the same both times. Sorting
     * by newest would reshuffle the index every time one document was
     * re-uploaded.
     */
    .sort((a, b) => a.ingestedAt.localeCompare(b.ingestedAt) || a.id.localeCompare(b.id));
}

export async function getDocument(id: string): Promise<SourceDocument | undefined> {
  return (await readStore<SourceDocument[]>("documents", [])).find((doc) => doc.id === id);
}

/**
 * The file itself.
 *
 * A missing file throws rather than returning an empty buffer. An empty buffer
 * would reach the model as a blank page and come back `unreadable`, which
 * records a storage fault as a fault of the document — and puts a filename on
 * the exceptions list that a reviewer will open, look at, and find perfectly
 * legible.
 */
export async function readDocumentBytes(id: string): Promise<Buffer> {
  const doc = await getDocument(id);
  if (!doc) throw new Error(`No document ${id} on the register.`);
  try {
    return await readFile(await fileFor(doc));
  } catch {
    throw new Error(
      `${doc.filename} (${doc.id}) is on the register but its file is missing from ` +
        `.data/documents. Re-run the seeder, or upload the file again.`,
    );
  }
}

export async function readDocumentBase64(id: string): Promise<string> {
  return (await readDocumentBytes(id)).toString("base64");
}

/**
 * Take in one file.
 *
 * The hash is computed and reported, and the file is ingested either way.
 * Deduplicating on arrival would hide that the same invoice reached the folder
 * twice — which is itself a finding, and one that only the collection step can
 * see. A document dropped here to keep the counts tidy is a document the
 * duplicate check downstream can never raise, so the caller gets `duplicateOf`
 * and the exception engine gets both rows.
 */
export async function ingest(input: {
  filename: string;
  bytes: Buffer;
  mimeType: string;
  source: DocumentSource;
  sourceRef?: string;
  sourceDetail?: string;
  periodId: string;
  actor: string;
  /** Supplied only by the seeder, which uses stable ids so a corpus reproduces. */
  id?: string;
}): Promise<{ doc: SourceDocument; duplicateOf?: SourceDocument }> {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await readStore<SourceDocument[]>("documents", []);
  const id = input.id ?? newId("doc");

  /**
   * The same bytes under the same id is a re-seed replacing its own row, not a
   * second arrival — reporting that as a duplicate would put a spurious flag on
   * every document each time the corpus is reloaded. A hash match in another
   * period still counts: the same invoice claimed in two quarters is precisely
   * the kind of thing a reviewer needs told, so the same-period match is
   * preferred only for which row is named.
   */
  const candidates = existing.filter((doc) => doc.sha256 === sha256 && doc.id !== id);
  const duplicateOf =
    candidates.find((doc) => doc.periodId === input.periodId) ?? candidates[0];

  const extension = EXTENSIONS[input.mimeType] ?? ".pdf";
  const storagePath = `documents/${id}${extension}`;

  // documentsDir() creates the directory, so there is no separate mkdir.
  await writeFile(path.join(await documentsDir(), `${id}${extension}`), input.bytes);

  const doc: SourceDocument = {
    id,
    periodId: input.periodId,
    filename: input.filename,
    source: input.source,
    sourceRef: input.sourceRef,
    sourceDetail: input.sourceDetail,
    mimeType: input.mimeType,
    bytes: input.bytes.byteLength,
    pageCount: countPages(input.bytes, input.mimeType),
    sha256,
    storagePath,
    ingestedAt: new Date().toISOString(),
    ingestedBy: input.actor,
  };

  // Replace by id rather than append blindly: two rows sharing an id would make
  // every join downstream pick one of them arbitrarily.
  await mutate<SourceDocument[], void>("documents", [], (docs) => ({
    next: docs.some((current) => current.id === id)
      ? docs.map((current) => (current.id === id ? doc : current))
      : [...docs, doc],
    result: undefined,
  }));

  await record({
    actor: input.actor,
    action: "document.ingest",
    subject: doc.id,
    result: "ok",
    detail:
      `Ingested ${doc.filename} (${doc.bytes} bytes, ` +
      `${doc.pageCount === undefined ? "page count not established" : `${doc.pageCount} page(s)`}) ` +
      `from ${doc.source}${doc.sourceDetail ? ` — ${doc.sourceDetail}` : ""}. ` +
      `sha256 ${sha256.slice(0, 12)}.`,
    periodId: doc.periodId,
    docId: doc.id,
  });

  if (duplicateOf) {
    // A second row in the trail rather than a clause in the first, so the
    // duplicate is greppable and dated independently of the ingest that found
    // it.
    await record({
      actor: input.actor,
      action: "document.duplicate-detected",
      subject: doc.id,
      result: "info",
      detail:
        `${doc.filename} is byte-identical to ${duplicateOf.filename} (${duplicateOf.id}, ` +
        `ingested ${duplicateOf.ingestedAt}). Both are kept: the second arrival is the finding.`,
      periodId: doc.periodId,
      docId: doc.id,
    });
  }

  return { doc, duplicateOf };
}

/**
 * Remove a document, its bytes, and everything derived from it.
 *
 * The reason is required and refused when blank, here as well as at the route.
 * A deletion with no reason is a gap in the corpus nobody can account for, and
 * the audit row is the only place the filename and hash survive it.
 *
 * The derived rows go with it. An extraction left behind after its document is
 * deleted still carries a total, and that total still lands on a Schedule C
 * line — a figure with no document behind it, on a form that looks fully
 * supported. That is the worst shape a wrong number can take here.
 *
 * Exceptions are deliberately *not* deleted. `detect` owns their lifecycle: it
 * drops findings that no longer apply and logs that it did, and it keeps the
 * resolution note a person wrote. Clearing them from here would erase that note
 * without anyone deciding to.
 */
export async function removeDocument(id: string, actor: string, reason: string): Promise<void> {
  const note = reason?.trim() ?? "";
  if (!note) {
    throw new Error("Deleting a document needs a reason. It is written to the audit trail.");
  }

  const doc = await getDocument(id);
  if (!doc) throw new Error(`No document ${id} on the register.`);

  // The row first, then the bytes. A file left without a row is invisible and
  // harmless; a row left pointing at a file that is gone breaks the viewer and
  // the extractor for as long as it sits there.
  await mutate<SourceDocument[], void>("documents", [], (docs) => ({
    next: docs.filter((current) => current.id !== id),
    result: undefined,
  }));
  await mutate<Extraction[], void>("extractions", [], (rows) => ({
    next: rows.filter((row) => row.docId !== id),
    result: undefined,
  }));
  await mutate<Classification[], void>("classifications", [], (rows) => ({
    next: rows.filter((row) => row.docId !== id),
    result: undefined,
  }));

  await rm(await fileFor(doc), { force: true });

  await record({
    actor,
    action: "document.delete",
    subject: doc.id,
    result: "ok",
    detail:
      `Deleted ${doc.filename} (${doc.id}, sha256 ${doc.sha256.slice(0, 12)}, ingested ` +
      `${doc.ingestedAt} from ${doc.source}) along with its extraction, categorisation and ` +
      `Reason: ${note}`,
    periodId: doc.periodId,
    docId: doc.id,
  });
}

/**
 * Every document in the period with everything known about it.
 *
 * One read per collection and then joins in memory, rather than a lookup per
 * document: the corpus is tens of files, and a per-document read would make the
 * documents tab's cost grow with the square of the corpus for no benefit.
 *
 * Absent fields stay absent. A document with no extraction gets `undefined`,
 * never a synthetic empty one — the console has to be able to tell "not read
 * yet" from "read, and it said nothing".
 */
/**
 * Delete a document's bytes while keeping its register row.
 *
 * Distinct from `removeDocument`, which forgets the document entirely. This is
 * the prune path: the row, the extraction and every finding raised against it
 * stay exactly as they are, and only the local copy of the file goes — because
 * Drive has it and the viewer can fetch it from there.
 */
export async function removeLocalFile(id: string): Promise<void> {
  const doc = await getDocument(id);
  if (!doc) return;
  await rm(await fileFor(doc), { force: true });
}

export async function documentViews(periodId: string): Promise<DocumentView[]> {
  const [docs, extractions, classifications, exceptions] = await Promise.all([
    listDocuments({ periodId }),
    readStore<Extraction[]>("extractions", []),
    readStore<Classification[]>("classifications", []),
    readStore<TaxException[]>("exceptions", []),
  ]);

  const extractionByDoc = new Map(extractions.map((row) => [row.docId, row]));
  const classificationByDoc = new Map(classifications.map((row) => [row.docId, row]));


  const exceptionsByDoc = new Map<string, TaxException[]>();
  for (const exception of exceptions) {
    for (const docId of exception.docIds) {
      const list = exceptionsByDoc.get(docId) ?? [];
      list.push(exception);
      exceptionsByDoc.set(docId, list);
    }
  }

  return docs.map((doc) => ({
    doc,
    extraction: extractionByDoc.get(doc.id),
    classification: classificationByDoc.get(doc.id),
    exceptions: (exceptionsByDoc.get(doc.id) ?? []).sort(
      (a, b) =>
        Number(a.status !== "open") - Number(b.status !== "open") ||
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        a.raisedAt.localeCompare(b.raisedAt),
    ),
  }));
}

/**
 * What each collection source returned, and whether it was asked.
 *
 * `available: false` is the whole point of this function. Google Drive and
 * Gmail are not wired into this build: no sweep has run against either, so the
 * number of documents in them is *unknown*. Reporting that as `documents: 0`
 * would put a zero on the console that reads as "there is nothing there", and a
 * quarter prepared on the strength of that zero is missing whatever was in the
 * folder. Zero rows from a sweep nobody ran is not "no documents".
 *
 * The counts are still returned for a source marked unavailable, because rows
 * labelled `drive` or `gmail` can exist — the fixture generator labels some
 * that way to exercise the mixed-source paths — and the detail says exactly
 * where they came from. The console renders an em dash for the figure whenever
 * `available` is false.
 */
export async function sourceBreakdown(periodId: string): Promise<PrepStatus["sources"]> {
  const docs = await listDocuments({ periodId });
  const count = (source: DocumentSource) => docs.filter((doc) => doc.source === source).length;

  const fixtures = count("fixture");
  const uploads = count("upload");
  const drive = count("drive");
  const gmail = count("gmail");

  const placed = (n: number, label: string) =>
    n > 0
      ? ` ${n} row(s) in this period are labelled ${label}; they were placed by the fixture ` +
        `generator, not collected by a sweep.`
      : "";

  return [
    {
      source: "fixture",
      available: fixtures > 0,
      documents: fixtures,
      detail:
        fixtures > 0
          ? `${fixtures} document(s) from the generated corpus.`
          : "No corpus loaded. Run npm run fixtures, then npm run seed.",
    },
    {
      source: "upload",
      available: true,
      documents: uploads,
      detail:
        uploads > 0
          ? `${uploads} document(s) uploaded by hand.`
          : "Nothing has been uploaded by hand. The upload path is open.",
    },
    {
      source: "drive",
      available: false,
      documents: drive,
      detail:
        "Google Drive is not wired into this build, so no sweep has run against it and the " +
        "figure is unknown rather than zero." +
        (process.env.DRIVE_FOLDER_ID?.trim()
          ? " DRIVE_FOLDER_ID is set, but a folder id is not a sweep."
          : "") +
        placed(drive, "drive"),
    },
    {
      source: "gmail",
      available: false,
      documents: gmail,
      detail:
        "Gmail is not wired into this build, so no search has run and the figure is unknown " +
        "rather than zero." +
        (process.env.GMAIL_QUERY?.trim()
          ? " GMAIL_QUERY is set, but a query is not a search."
          : "") +
        placed(gmail, "gmail"),
    },
  ];
}
