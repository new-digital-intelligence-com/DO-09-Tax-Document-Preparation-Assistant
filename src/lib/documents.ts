import "server-only";
import { createHash } from "node:crypto";
import { record, recordMany } from "./audit";
import { downloadFile, findInFolder, trashFile, uploadFile, workspace } from "./drive";
import { mutate, newId, readStore } from "./store";
import type {
  AuditEvent,
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
 *
 * The bytes themselves live only on Drive, in the active user's `input/`
 * folder. There is no local copy at any point, on this machine or any other —
 * `ingest` uploads straight to Drive, and `readDocumentBytes` downloads from
 * there on every call. A document's row carries `sourceRef`, the Drive file's
 * own id, as the one thing that says where its bytes actually are.
 */

/** Worst first, so the first flag on a document is the one that matters most. */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

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
 * The file itself, fetched from Drive.
 *
 * `sourceRef` — the Drive file's own id — is tried first, and a name lookup in
 * the `input` folder is the fallback: an id can go stale if the file was
 * replaced on Drive directly, but the filename usually has not moved. A
 * document findable by neither throws rather than returning an empty buffer —
 * an empty buffer would reach the model as a blank page and come back
 * `unreadable`, which records a storage fault as a fault of the document.
 */
export async function readDocumentBytes(id: string): Promise<Buffer> {
  const doc = await getDocument(id);
  if (!doc) throw new Error(`No document ${id} on the register.`);

  const folders = await workspace();

  if (doc.sourceRef) {
    try {
      return await downloadFile(doc.sourceRef);
    } catch {
      // Fall through to a name lookup.
    }
  }

  const match = await findInFolder(folders.inputId, doc.filename);
  if (!match) {
    throw new Error(
      `${doc.filename} (${doc.id}) is on the register but its file is not in the Drive input ` +
        "folder. It may have been moved or removed there directly — check the workspace folder.",
    );
  }
  return downloadFile(match.id);
}

export async function readDocumentBase64(id: string): Promise<string> {
  return (await readDocumentBytes(id)).toString("base64");
}

/**
 * Take in one file.
 *
 * The bytes are uploaded to the Drive `input` folder as part of this call —
 * unless `sourceRef` already names a Drive file, which is the sweep's case:
 * the bytes came FROM `input/` in the first place, so uploading them back
 * would just create a second copy of the file that produced this call.
 *
 * The hash is computed and reported, and the file is ingested either way.
 * Deduplicating on arrival would hide that the same invoice reached the folder
 * twice — which is itself a finding, and one that only the collection step can
 * see. A document dropped here to keep the counts tidy is a document the
 * duplicate check downstream can never raise, so the caller gets `duplicateOf`
 * and the exception engine gets both rows.
 */

type IngestInput = {
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
};

/**
 * The register row for one file, computed but not written anywhere.
 *
 * `existing` is passed in rather than read here, so a caller ingesting many
 * files at once — the sweep's case — reads the register once for the whole
 * batch instead of once per file. `duplicateOf` is found against whatever the
 * caller passed, which for a batch includes rows built earlier in the SAME
 * batch: two identical files arriving in one sweep are still each other's
 * duplicate, even though neither was on the register a moment before either
 * of them was.
 */
function buildDocumentRow(
  input: IngestInput & { sourceRef: string },
  existing: SourceDocument[],
): { doc: SourceDocument; duplicateOf?: SourceDocument } {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
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
  const duplicateOf = candidates.find((doc) => doc.periodId === input.periodId) ?? candidates[0];

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
    ingestedAt: new Date().toISOString(),
    ingestedBy: input.actor,
  };

  return { doc, duplicateOf };
}

const ingestDetail = (doc: SourceDocument, sha256: string) =>
  `Ingested ${doc.filename} (${doc.bytes} bytes, ` +
  `${doc.pageCount === undefined ? "page count not established" : `${doc.pageCount} page(s)`}) ` +
  `from ${doc.source}${doc.sourceDetail ? ` — ${doc.sourceDetail}` : ""}. sha256 ${sha256.slice(0, 12)}.`;

const duplicateDetail = (doc: SourceDocument, duplicateOf: SourceDocument) =>
  `${doc.filename} is byte-identical to ${duplicateOf.filename} (${duplicateOf.id}, ` +
  `ingested ${duplicateOf.ingestedAt}). Both are kept: the second arrival is the finding.`;

export async function ingest(input: IngestInput): Promise<{ doc: SourceDocument; duplicateOf?: SourceDocument }> {
  const existing = await readStore<SourceDocument[]>("documents", []);

  let sourceRef = input.sourceRef;
  if (!sourceRef) {
    const folders = await workspace();
    const uploaded = await uploadFile({
      parentId: folders.inputId,
      name: input.filename,
      bytes: input.bytes,
      mimeType: input.mimeType,
    });
    sourceRef = uploaded.id;
  }

  const { doc, duplicateOf } = buildDocumentRow({ ...input, sourceRef }, existing);

  // Replace by id rather than append blindly: two rows sharing an id would make
  // every join downstream pick one of them arbitrarily.
  await mutate<SourceDocument[], void>("documents", [], (docs) => ({
    next: docs.some((current) => current.id === doc.id)
      ? docs.map((current) => (current.id === doc.id ? doc : current))
      : [...docs, doc],
    result: undefined,
  }));

  await record({
    actor: input.actor,
    action: "document.ingest",
    subject: doc.id,
    result: "ok",
    detail: ingestDetail(doc, doc.sha256),
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
      detail: duplicateDetail(doc, duplicateOf),
      periodId: doc.periodId,
      docId: doc.id,
    });
  }

  return { doc, duplicateOf };
}

/**
 * `ingest`, for many files whose bytes are already on Drive.
 *
 * Built for the sweep, which can find dozens of unfamiliar files in the
 * `input` folder at once. Calling `ingest` once per file would mean reading
 * and rewriting the WHOLE document register, and appending to the WHOLE audit
 * trail, once per file — a workspace with forty documents already on record
 * pays for reading and rewriting all forty, forty separate times, to add one
 * more each time. This reads the register once, computes every row in memory,
 * and writes the register and the audit trail once each for the entire batch.
 *
 * Every input must already carry `sourceRef` — the Drive file id — because
 * the whole reason this exists is to skip the per-file upload step; a caller
 * with bytes that are not yet on Drive should use `ingest` instead.
 */
export async function ingestMany(
  inputs: (IngestInput & { sourceRef: string })[],
): Promise<{ doc: SourceDocument; duplicateOf?: SourceDocument }[]> {
  if (inputs.length === 0) return [];

  const existing = await readStore<SourceDocument[]>("documents", []);
  const seenSoFar = [...existing];
  const built: { doc: SourceDocument; duplicateOf?: SourceDocument }[] = [];

  for (const input of inputs) {
    const result = buildDocumentRow(input, seenSoFar);
    built.push(result);
    // So two identical files arriving in the SAME sweep are each other's
    // duplicate too, not just duplicates of something already on record.
    seenSoFar.push(result.doc);
  }

  await mutate<SourceDocument[], void>("documents", [], (docs) => ({
    next: [...docs, ...built.map((row) => row.doc)],
    result: undefined,
  }));

  const auditRows: Omit<AuditEvent, "id" | "at">[] = [];
  for (const { doc, duplicateOf } of built) {
    auditRows.push({
      actor: doc.ingestedBy,
      action: "document.ingest",
      subject: doc.id,
      result: "ok",
      detail: ingestDetail(doc, doc.sha256),
      periodId: doc.periodId,
      docId: doc.id,
    });
    if (duplicateOf) {
      auditRows.push({
        actor: doc.ingestedBy,
        action: "document.duplicate-detected",
        subject: doc.id,
        result: "info",
        detail: duplicateDetail(doc, duplicateOf),
        periodId: doc.periodId,
        docId: doc.id,
      });
    }
  }
  await recordMany(auditRows);

  return built;
}

/**
 * Take a document out of the shared workspace entirely.
 *
 * Used for a document that turned out not to belong there — declined as out
 * of scope, most often. The Drive file is trashed (recoverable from Drive's
 * own trash, never permanently destroyed by this app) rather than left
 * sitting in `input/`: that folder is the tax workspace, and a photograph or
 * a CV left in it because someone dropped it on the upload button is exactly
 * the data-minimisation failure the operating rules warn about. The register
 * row is kept — the person who uploaded it is still owed a record of what
 * happened and why — only the file content is withdrawn.
 */
export async function withdrawFromWorkspace(id: string, actor: string, reason: string): Promise<void> {
  const doc = await getDocument(id);
  if (!doc?.sourceRef) return;
  try {
    await trashFile(doc.sourceRef);
  } catch (error) {
    await record({
      actor,
      action: "document.withdraw-failed",
      subject: id,
      result: "error",
      detail:
        `${doc.filename} could not be removed from the Drive input folder: ` +
        `${error instanceof Error ? error.message : "unknown error"}. Reason for withdrawal: ${reason}.`,
      periodId: doc.periodId,
      docId: id,
    });
    return;
  }
  await record({
    actor,
    action: "document.withdrawn",
    subject: id,
    result: "info",
    detail: `${doc.filename} was removed from the Drive input folder: ${reason}. The register row is kept.`,
    periodId: doc.periodId,
    docId: id,
  });
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
 * Findings go too, but by subtraction rather than by the axe. A flag raised
 * against three documents still means something when one of them leaves, so
 * the id is removed from it and the finding stands; a flag that was only ever
 * about this document has nothing left to be about, and is dropped. Leaving
 * either behind would put a finding on the review screen pointing at a
 * document nobody can open.
 *
 * Two things on Drive are trashed rather than merely forgotten, and both are
 * the difference between a deletion that holds and one that quietly reverses
 * itself:
 *
 *   The file in `input/`. A row removed from the register but left sitting in
 *   the folder reappears as an unfamiliar file on the very next sweep and is
 *   ingested straight back in.
 *
 * The cached result in `output/` is NOT dropped here, and that is a layering
 * choice rather than an omission: the cache belongs to the pipeline, which
 * sits above this module and already imports it. `purgeDocument` in
 * `workspace-sync` is the complete deletion — it calls this and then clears
 * the cache — and it is what the route and the console use. Calling this
 * directly removes the document from the register but leaves its cached result
 * behind, which means re-uploading the same bytes restores the old figures
 * without reading anything.
 */
export async function removeDocument(id: string, actor: string, reason: string): Promise<void> {
  const note = reason?.trim() ?? "";
  if (!note) {
    throw new Error("Deleting a document needs a reason. It is written to the audit trail.");
  }

  const doc = await getDocument(id);
  if (!doc) throw new Error(`No document ${id} on the register.`);

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

  const findings = await mutate<TaxException[], { dropped: number; narrowed: number }>(
    "exceptions",
    [],
    (rows) => {
      let dropped = 0;
      let narrowed = 0;
      const next: TaxException[] = [];
      for (const row of rows) {
        if (!row.docIds.includes(id)) {
          next.push(row);
          continue;
        }
        const remaining = row.docIds.filter((docId) => docId !== id);
        if (remaining.length === 0) {
          dropped += 1;
          continue;
        }
        narrowed += 1;
        next.push({ ...row, docIds: remaining });
      }
      return { next, result: { dropped, narrowed } };
    },
  );

  if (doc.sourceRef) {
    try {
      await trashFile(doc.sourceRef);
    } catch {
      // The register no longer lists this document either way; a file that
      // could not be trashed is a Drive-side cleanup task, not a reason to
      // fail the deletion the person actually asked for.
    }
  }

  await record({
    actor,
    action: "document.delete",
    subject: doc.id,
    result: "ok",
    detail:
      `Deleted ${doc.filename} (${doc.id}, sha256 ${doc.sha256.slice(0, 12)}, ingested ` +
      `${doc.ingestedAt} from ${doc.source}) along with its extraction and categorisation. ` +
      `${findings.dropped} finding(s) dropped and ${findings.narrowed} narrowed to their other ` +
      `documents. The file was trashed on Drive. Reason: ${note}`,
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
 * `available: false` is the whole point of this function for a source nothing
 * has ever asked. Gmail is not one of this app's sources and is not going to
 * be: reading a mailbox was built and then deliberately removed, along with
 * the permission behind it. So the number of documents in anybody's mail is
 * *unknown*, and reporting it as `documents: 0` would put a zero on the
 * console that reads as "there is nothing there" — a claim this app has no
 * standing to make about a mailbox it cannot open.
 *
 * Drive, by contrast, is swept for real and reported with a genuine count.
 */
export async function sourceBreakdown(periodId: string): Promise<PrepStatus["sources"]> {
  const docs = await listDocuments({ periodId });
  const count = (source: DocumentSource) => docs.filter((doc) => doc.source === source).length;

  const fixtures = count("fixture");
  const uploads = count("upload");
  const drive = count("drive");
  const gmail = count("gmail");

  return [
    {
      source: "fixture",
      available: fixtures > 0,
      documents: fixtures,
      detail:
        fixtures > 0
          ? `${fixtures} document(s) from the generated corpus.`
          : "No corpus loaded. Run npm run fixtures to generate one, then sweep it into a workspace.",
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
      available: true,
      documents: drive,
      detail:
        drive > 0
          ? `${drive} document(s) collected from the workspace's Drive input folder.`
          : "The Drive input folder has not produced any documents in this period yet.",
    },
    {
      source: "gmail",
      available: false,
      documents: gmail,
      detail:
        "This app does not read anybody's mail — the permission is not requested — so no search " +
        "has run and the figure is unknown rather than zero. An emailed invoice is added by " +
        "saving it and using Add documents." +
        (gmail > 0
          ? ` ${gmail} row(s) in this period are labelled gmail; they were placed by the fixture ` +
            "generator, not collected by a sweep."
          : ""),
    },
  ];
}
