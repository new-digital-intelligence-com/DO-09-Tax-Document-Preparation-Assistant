import "server-only";
import { createHash } from "node:crypto";
import { record } from "./audit";
import { classifyDocument, getClassification } from "./classify";
import {
  getDocument,
  ingest,
  listDocuments,
  readDocumentBytes,
  recordDriveFile,
  removeLocalFile,
} from "./documents";
import {
  downloadFile,
  driveStatus,
  findInFolder,
  listFolder,
  putFile,
  putJson,
  readTextFile,
  workspace,
} from "./drive";
import { extractDocument, getExtraction } from "./extract";
import { activePeriod, preparer } from "./settings";
import { readStore, writeStore } from "./store";
import type { Classification, Extraction, SourceDocument } from "./types";

/**
 * The shared workspace on Drive, and the reason a second run is cheap.
 *
 * Reading a document costs a model call per page and categorising it costs a
 * share of another. Doing that again for a document nobody has touched is pure
 * waste, and on a corpus of any size it is the difference between a sweep that
 * takes a minute and one that takes twenty.
 *
 * So every result is written back to the `output` folder beside the `input`
 * that produced it, keyed by the SHA-256 of the file's bytes. The hash is the
 * right key rather than the filename or the Drive id: the same invoice saved
 * twice under two names is one document and should cost one reading, and a file
 * that was edited is a different document even though its name did not change.
 *
 * What this deliberately does NOT cache is anything downstream of one document.
 * The exception list and the draft forms are computed over the
 * whole period and are cheap; caching them would mean a stale finding surviving
 * a change to the document it was raised against.
 */

/** Bumped when the shape of a cached result changes, so old ones are re-read. */
const RESULT_VERSION = 1;

export type CachedResult = {
  version: number;
  sha256: string;
  filename: string;
  /** Where it originally came from, for the audit trail. */
  source: SourceDocument["source"];
  sourceDetail?: string;
  processedAt: string;
  processedBy: string;
  modelId?: string;
  extraction?: Extraction;
  classification?: Classification;
};

export type DocumentOutcome = {
  docId: string;
  filename: string;
  sha256: string;
  /**
   * What actually happened, and the console shows all four differently.
   *
   * `reused` is the one that matters: it means the model was not called, and a
   * run that quietly re-read everything while reporting success would make this
   * whole cache pointless to have written.
   */
  status: "reused" | "computed" | "declined" | "failed";
  detail: string;
  vendor?: string;
  total?: number;
  currency?: string;
  categoryId?: string;
  /** Set when the result was written back to Drive on this run. */
  storedToDrive?: boolean;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Hashing and naming
 * ────────────────────────────────────────────────────────────────────────── */

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The cache file's name. The hash alone, so a lookup is one `findInFolder`. */
function resultName(sha256: string): string {
  return `${sha256}.json`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The cache
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A local mirror of what Drive holds, so a sweep does not ask Drive once per
 * document. Rebuilt at the start of every run; never the source of truth.
 */
type CacheIndex = Record<string, { fileId: string; name: string }>;

async function outputIndex(): Promise<CacheIndex> {
  const folders = await workspace();
  const files = await listFolder(folders.outputId);
  const index: CacheIndex = {};
  for (const file of files) {
    if (file.name.endsWith(".json")) {
      index[file.name.replace(/\.json$/, "")] = { fileId: file.id, name: file.name };
    }
  }
  return index;
}

/** Read one cached result, or nothing. A parse failure is a miss, not a crash. */
export async function readCachedResult(
  sha256: string,
  index?: CacheIndex,
): Promise<CachedResult | undefined> {
  try {
    const folders = await workspace();
    const hit = index?.[sha256] ?? (await findInFolder(folders.outputId, resultName(sha256)));
    if (!hit) return undefined;

    const fileId = "fileId" in hit ? hit.fileId : hit.id;
    const parsed = JSON.parse(await readTextFile(fileId)) as CachedResult;

    // A result written by an older shape is not trusted. Re-reading a document
    // costs a call; acting on a figure whose meaning has changed costs more.
    if (parsed.version !== RESULT_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Write a result back beside its input. Failure is reported, never swallowed. */
export async function writeCachedResult(result: CachedResult): Promise<boolean> {
  const folders = await workspace();
  await putJson(folders.outputId, resultName(result.sha256), result);
  return true;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Applying a cached result locally
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Put a cached extraction and categorisation into the local register.
 *
 * The `docId` on a cached row belongs to whichever run first produced it, so
 * both are rewritten to this workspace's id. Without that the row is stored
 * against a document that does not exist here and every join downstream
 * silently drops it.
 */
async function applyCached(docId: string, cached: CachedResult): Promise<void> {
  if (cached.extraction) {
    const rows = await readStore<Extraction[]>("extractions", []);
    const row: Extraction = { ...cached.extraction, docId };
    await writeStore(
      "extractions",
      [...rows.filter((r) => r.docId !== docId), row].sort((a, b) => a.docId.localeCompare(b.docId)),
    );
  }
  if (cached.classification) {
    const rows = await readStore<Classification[]>("classifications", []);
    const row: Classification = { ...cached.classification, docId };
    await writeStore(
      "classifications",
      [...rows.filter((r) => r.docId !== docId), row].sort((a, b) => a.docId.localeCompare(b.docId)),
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Processing one document
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Read and categorise one document, unless Drive already holds the answer.
 *
 * `force` exists for the case where the prompt or the chart changed and the
 * cached answer is stale in a way the hash cannot see. It is never the default:
 * a run that silently re-read everything would be indistinguishable from a
 * cache that does not work.
 */
export async function processDocument(
  docId: string,
  options: { force?: boolean; index?: CacheIndex; actor?: string } = {},
): Promise<DocumentOutcome> {
  const actor = options.actor ?? preparer();
  const doc = await getDocument(docId);
  if (!doc) {
    return {
      docId,
      filename: docId,
      sha256: "",
      status: "failed",
      detail: `No document ${docId} on the register.`,
    };
  }

  const base = { docId, filename: doc.filename, sha256: doc.sha256 };
  const driveReady = driveStatus().state === "ready";

  // 1. The cache, when Drive is reachable.
  if (!options.force && driveReady) {
    const cached = await readCachedResult(doc.sha256, options.index);
    if (cached?.extraction) {
      await applyCached(docId, cached);
      await record({
        actor,
        action: "document.reused",
        subject: docId,
        result: "info",
        detail:
          `${doc.filename} was already processed on ${cached.processedAt} and its result was read ` +
          `from the Drive output folder. No model call was made.`,
        periodId: doc.periodId,
        docId,
      });
      return {
        ...base,
        status: "reused",
        detail: `Already processed on ${cached.processedAt.slice(0, 10)}. Read from Drive, not re-read.`,
        vendor: cached.extraction.vendor,
        total: cached.extraction.total,
        currency: cached.extraction.currency,
        categoryId: cached.classification?.categoryId,
      };
    }
  }

  // 2. Read it.
  let extraction: Extraction;
  try {
    extraction = await extractDocument(docId, actor);
  } catch (error) {
    return {
      ...base,
      status: "failed",
      detail: error instanceof Error ? error.message : "The document could not be read.",
    };
  }

  // 3. A document that is not a financial record is declined rather than
  //    forced onto the chart. It stays on the register with its reason so the
  //    person who uploaded it can see what happened to it.
  if (extraction.status === "out-of-scope") {
    await record({
      actor,
      action: "document.declined",
      subject: docId,
      result: "info",
      detail: `${doc.filename} is not a financial document: ${extraction.statusDetail ?? "no reason given"}`,
      periodId: doc.periodId,
      docId,
    });
    return {
      ...base,
      status: "declined",
      detail: extraction.statusDetail ?? "Not a financial document, so nothing was extracted from it.",
    };
  }

  // 4. Categorise it.
  let classification: Classification | undefined;
  try {
    classification = await classifyDocument(docId, actor);
  } catch {
    // A categorisation that failed leaves a readable extraction in place. The
    // document shows as read but unsorted, which is true and recoverable.
    classification = await getClassification(docId);
  }

  // 5. Write the answer back so the next run does not pay for it again.
  let storedToDrive = false;
  if (driveReady) {
    try {
      await writeCachedResult({
        version: RESULT_VERSION,
        sha256: doc.sha256,
        filename: doc.filename,
        source: doc.source,
        sourceDetail: doc.sourceDetail,
        processedAt: new Date().toISOString(),
        processedBy: actor,
        modelId: extraction.modelId,
        extraction,
        classification,
      });
      storedToDrive = true;
    } catch (error) {
      // Worth saying out loud: the work was done and the answer is on screen,
      // but the next run will pay for it again.
      await record({
        actor,
        action: "document.cache-failed",
        subject: docId,
        result: "error",
        detail:
          `${doc.filename} was processed but its result could not be written to Drive: ` +
          `${error instanceof Error ? error.message : "unknown error"}. The next run will read it again.`,
        periodId: doc.periodId,
        docId,
      });
    }
  }

  return {
    ...base,
    status: extraction.status === "extracted" ? "computed" : "failed",
    detail:
      extraction.status === "extracted"
        ? `Read and categorised${storedToDrive ? ", and saved to Drive" : ""}.`
        : (extraction.statusDetail ?? `Came back ${extraction.status}.`),
    vendor: extraction.vendor,
    total: extraction.total,
    currency: extraction.currency,
    categoryId: classification?.categoryId,
    storedToDrive,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pulling the input folder in
 * ────────────────────────────────────────────────────────────────────────── */

const DOCUMENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);

/**
 * Bring anything new in the Drive `input` folder onto the local register.
 *
 * Matching is by hash, so a file renamed on Drive is recognised as the document
 * already held rather than ingested a second time. A file whose type cannot be
 * given to the model is skipped with a reason rather than ingested into a
 * corpus where it will fail one document at a time.
 */
export async function syncFromDrive(actor = preparer()): Promise<{
  found: number;
  ingested: number;
  alreadyHeld: number;
  skipped: { name: string; reason: string }[];
}> {
  const status = driveStatus();
  if (status.state !== "ready") throw new Error(status.detail);

  const period = await activePeriod();
  const folders = await workspace();
  const files = await listFolder(folders.inputId);

  // Identity for "have I already synced this Drive file" is the Drive file's
  // OWN id, never the content hash. Content hash is the wrong key here: two
  // input files can legitimately hold identical bytes — the same invoice
  // uploaded twice by mistake — and that is exactly the case this app exists
  // to catch, not to silently collapse. A hash-keyed check ingests the first
  // copy, remembers its hash, and then skips the second copy as "already
  // held" within the very same pass, which is how a real duplicate quietly
  // vanishes before the duplicate-document exception ever gets a chance to
  // see it. Keying on the Drive file id instead means every distinct file in
  // the folder is ingested once, and it is `documents.ts` / `exceptions.ts`
  // — not this sweep — that decides two of them are suspiciously alike.
  const heldFileIds = new Set(
    (await listDocuments({ periodId: period.id }))
      .filter((doc) => doc.sourceRef)
      .map((doc) => doc.sourceRef),
  );
  const skipped: { name: string; reason: string }[] = [];
  let ingested = 0;
  let alreadyHeld = 0;

  for (const file of files) {
    if (file.mimeType === "application/vnd.google-apps.folder") continue;

    if (heldFileIds.has(file.id)) {
      alreadyHeld++;
      continue;
    }

    if (!DOCUMENT_TYPES.has(file.mimeType)) {
      skipped.push({
        name: file.name,
        reason: `${file.mimeType} cannot be given to the model as a page. Only PDF, PNG and JPEG can.`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await downloadFile(file.id);
    } catch (error) {
      skipped.push({
        name: file.name,
        reason: `Could not be downloaded: ${error instanceof Error ? error.message : "unknown error"}`,
      });
      continue;
    }

    await ingest({
      filename: file.name,
      bytes,
      mimeType: file.mimeType,
      source: "drive",
      sourceRef: file.id,
      sourceDetail: `Drive · input/${file.name}`,
      periodId: period.id,
      actor,
    });
    heldFileIds.add(file.id);
    ingested++;
  }

  await record({
    actor,
    action: "drive.sync",
    subject: folders.inputId,
    result: "ok",
    detail:
      `Swept the Drive input folder: ${files.length} file(s) there, ${ingested} newly collected, ` +
      `${alreadyHeld} already held, ${skipped.length} skipped.` +
      (skipped.length ? ` Skipped: ${skipped.map((s) => s.name).join(", ")}.` : ""),
    periodId: period.id,
  });

  return { found: files.length, ingested, alreadyHeld, skipped };
}

/**
 * Put a document into the Drive `input` folder.
 *
 * Called after an upload has been processed successfully, so the shared folder
 * accumulates every document the workspace has actually worked on and the next
 * run — from the app or from a Claude session — starts from the same corpus.
 * A document that was declined as out of scope is never uploaded: the folder is
 * the tax workspace, and putting somebody's holiday photo in it because they
 * dropped it on the page is exactly the data-minimisation failure the rules
 * warn about.
 */
export async function pushDocumentToDrive(docId: string): Promise<{ stored: boolean; detail: string }> {
  if (driveStatus().state !== "ready") {
    return { stored: false, detail: "Drive is not connected, so the document stays local." };
  }

  const doc = await getDocument(docId);
  if (!doc) return { stored: false, detail: `No document ${docId} on the register.` };

  const folders = await workspace();

  // Already there under this name and hash? Uploading again would give the
  // folder two copies of one document and the corpus a duplicate finding that
  // nobody caused.
  const existing = await findInFolder(folders.inputId, doc.filename);
  if (existing) {
    try {
      if (sha256Of(await downloadFile(existing.id)) === doc.sha256) {
        // Present under this exact name and these exact bytes. The row may
        // still not know it — e.g. it was pushed on an earlier run before this
        // bookkeeping existed — so the id is recorded regardless of whether
        // this call actually uploaded anything.
        await recordDriveFile(docId, existing.id);
        return { stored: true, detail: "Already in the Drive input folder." };
      }
    } catch {
      // Fall through and upload under the same name; `putFile` replaces it.
    }
  }

  const bytes = await readDocumentBytes(docId);
  const uploaded = await putFile({
    parentId: folders.inputId,
    name: doc.filename,
    bytes,
    mimeType: doc.mimeType,
  });

  // Recorded so a later full sync — from this machine or a fresh one — knows
  // this Drive file is the very same document rather than an unfamiliar
  // arrival to be ingested a second time.
  await recordDriveFile(docId, uploaded.id);

  return { stored: true, detail: "Added to the Drive input folder." };
}

/**
 * Push what this workspace already holds up to Drive.
 *
 * The backfill case, and it matters more than it sounds. A corpus collected and
 * read before Drive was connected exists only on this machine: the documents
 * are in the local register and their answers are in local JSON, and a Claude
 * session looking at the shared folder would see an empty workspace and
 * conclude the period had not been started.
 *
 * Nothing is re-read. Every document already has an extraction and most have a
 * categorisation, so this uploads the files and writes the answers that are
 * already on record. Paying for forty model calls to produce results that are
 * sitting on disk would be absurd, and worse, the second answers could differ
 * in wording from the ones the drafts were built from.
 */
export async function publishToDrive(actor = preparer()): Promise<{
  documents: number;
  filesUploaded: number;
  resultsWritten: number;
  skipped: { filename: string; reason: string }[];
}> {
  const status = driveStatus();
  if (status.state !== "ready") throw new Error(status.detail);

  const period = await activePeriod();
  const docs = await listDocuments({ periodId: period.id });
  const skipped: { filename: string; reason: string }[] = [];
  let filesUploaded = 0;
  let resultsWritten = 0;

  for (const doc of docs) {
    const extraction = await getExtraction(doc.id);

    // A document nobody has read yet is uploaded so the folder holds the
    // corpus, but no result is written for it — an empty result file would be
    // read back on the next run as "already processed, nothing found".
    try {
      const pushed = await pushDocumentToDrive(doc.id);
      if (pushed.stored) filesUploaded++;
      else skipped.push({ filename: doc.filename, reason: pushed.detail });
    } catch (error) {
      skipped.push({
        filename: doc.filename,
        reason: error instanceof Error ? error.message : "upload failed",
      });
      continue;
    }

    if (!extraction) continue;

    try {
      await writeCachedResult({
        version: RESULT_VERSION,
        sha256: doc.sha256,
        filename: doc.filename,
        source: doc.source,
        sourceDetail: doc.sourceDetail,
        processedAt: extraction.extractedAt,
        processedBy: actor,
        modelId: extraction.modelId,
        extraction,
        classification: await getClassification(doc.id),
      });
      resultsWritten++;
    } catch (error) {
      skipped.push({
        filename: doc.filename,
        reason: `result not written: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  await record({
    actor,
    action: "drive.publish",
    subject: period.id,
    result: "ok",
    detail:
      `Published the local workspace to Drive: ${filesUploaded} document(s) uploaded and ` +
      `${resultsWritten} stored result(s) written, out of ${docs.length} on the register.` +
      (skipped.length ? ` ${skipped.length} skipped.` : ""),
    periodId: period.id,
  });

  return { documents: docs.length, filesUploaded, resultsWritten, skipped };
}

/**
 * Drop the local copy of anything Drive already holds.
 *
 * Drive is the source. Keeping a second copy of every PDF on this machine makes
 * the workspace twice as large for no benefit, and worse, it makes it ambiguous
 * which copy is authoritative when they differ — a file replaced on Drive would
 * still preview from the stale local one and nothing would say so.
 *
 * The check before each delete is what makes this safe: the file is downloaded
 * from Drive and its hash compared against the register row, and only an exact
 * match is removed. A document Drive does not have, or has under different
 * bytes, keeps its local copy. Deleting the only copy of somebody's receipt to
 * save a few kilobytes is not a trade worth making.
 *
 * `/api/documents/[id]/file` already falls back to Drive, so the viewer keeps
 * working with nothing stored here at all.
 */
export async function pruneLocalDocuments(actor = preparer()): Promise<{
  checked: number;
  removed: number;
  bytesFreed: number;
  kept: { filename: string; reason: string }[];
}> {
  const status = driveStatus();
  if (status.state !== "ready") throw new Error(status.detail);

  const period = await activePeriod();
  const folders = await workspace();
  const docs = await listDocuments({ periodId: period.id });

  const onDrive = new Map(
    (await listFolder(folders.inputId)).map((file) => [file.name, file]),
  );

  const kept: { filename: string; reason: string }[] = [];
  let removed = 0;
  let bytesFreed = 0;

  for (const doc of docs) {
    // No local copy is the goal state, not a problem.
    try {
      await readDocumentBytes(doc.id);
    } catch {
      continue;
    }

    const remote = onDrive.get(doc.filename);
    if (!remote) {
      kept.push({ filename: doc.filename, reason: "not in the Drive input folder" });
      continue;
    }

    try {
      const bytes = await downloadFile(remote.id);
      if (sha256Of(bytes) !== doc.sha256) {
        kept.push({
          filename: doc.filename,
          reason: "the copy on Drive has different bytes from the one on record",
        });
        continue;
      }
    } catch (error) {
      kept.push({
        filename: doc.filename,
        reason: `could not be verified on Drive: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
      continue;
    }

    await removeLocalFile(doc.id);
    removed++;
    bytesFreed += doc.bytes;
  }

  await record({
    actor,
    action: "workspace.prune",
    subject: period.id,
    result: "ok",
    detail:
      `Removed ${removed} local document file(s) (${Math.round(bytesFreed / 1024)} KB) that Drive ` +
      `holds byte-for-byte. ${kept.length} kept because they could not be verified there. The ` +
      `register rows are untouched; the viewer reads those documents from Drive.`,
    periodId: period.id,
  });

  return { checked: docs.length, removed, bytesFreed, kept };
}

/**
 * Pull in whatever this workspace already has on Drive, at no cost.
 *
 * The gap this closes: the picker can correctly recognise that a workspace
 * exists on Drive (`syncUsersFromDrive` in `users.ts` reads the folder even on
 * a machine that has never seen it before) — but recognising a workspace is
 * not the same as having its documents. A machine opening it for the first
 * time still has an empty local register, because nothing has pulled the
 * files and their answers down onto THIS disk yet. Without this step the
 * console reads "no documents collected" for a workspace that plainly has
 * thirty-nine of them, because it is asking the wrong question — "what is on
 * this machine" instead of "what is on Drive".
 *
 * It never calls the model. Anything with no cached answer in `output/` is
 * left unread rather than paid for on every machine a shared workspace is
 * opened from — that cost belongs to a deliberate Run, not to opening a tab.
 */
export async function hydrateFromDrive(actor = preparer()): Promise<{ ingested: number; applied: number }> {
  if (driveStatus().state !== "ready") return { ingested: 0, applied: 0 };

  let ingested = 0;
  try {
    ingested = (await syncFromDrive(actor)).ingested;
  } catch {
    // An unreadable Drive is surfaced on the Workspace screen's own status
    // strip; switching workspaces must not throw over it.
    return { ingested: 0, applied: 0 };
  }

  const period = await activePeriod();
  const [docs, extractions, index] = await Promise.all([
    listDocuments({ periodId: period.id }),
    readStore<Extraction[]>("extractions", []),
    outputIndex().catch(() => undefined),
  ]);
  const alreadyRead = new Set(extractions.map((row) => row.docId));

  let applied = 0;
  for (const doc of docs) {
    if (alreadyRead.has(doc.id)) continue;
    const cached = await readCachedResult(doc.sha256, index);
    if (!cached?.extraction) continue;
    await applyCached(doc.id, cached);
    applied++;
  }

  if (ingested > 0 || applied > 0) {
    await record({
      actor,
      action: "workspace.hydrate",
      subject: period.id,
      result: "ok",
      detail:
        `Opened this workspace on a machine with no local copy of it: pulled in ${ingested} ` +
        `document(s) from Drive and applied ${applied} already-processed result(s) from the output ` +
        `folder. No model call was made.`,
      periodId: period.id,
    });
  }

  return { ingested, applied };
}

/* ────────────────────────────────────────────────────────────────────────────
 * A whole run
 * ────────────────────────────────────────────────────────────────────────── */

export type RunSummary = {
  driveState: ReturnType<typeof driveStatus>["state"];
  sync?: Awaited<ReturnType<typeof syncFromDrive>>;
  total: number;
  reused: number;
  computed: number;
  declined: number;
  failed: number;
  outcomes: DocumentOutcome[];
};

/**
 * Sweep, then process everything the period holds.
 *
 * Every document appears in `outcomes`, including the ones nothing was done to.
 * That is the point of the screen this feeds: the operator wants to watch the
 * period being worked through, and a run that only reported the documents it
 * happened to re-read would look like it had skipped most of the corpus.
 */
export async function runPeriod(options: { force?: boolean; actor?: string } = {}): Promise<RunSummary> {
  const actor = options.actor ?? preparer();
  const period = await activePeriod();
  const state = driveStatus().state;

  let sync: RunSummary["sync"];
  if (state === "ready") {
    try {
      sync = await syncFromDrive(actor);
    } catch (error) {
      await record({
        actor,
        action: "drive.sync-failed",
        subject: period.id,
        result: "error",
        detail: `The Drive input folder could not be swept: ${error instanceof Error ? error.message : "unknown error"}`,
        periodId: period.id,
      });
    }
  }

  const index = state === "ready" ? await outputIndex().catch(() => undefined) : undefined;
  const docs = await listDocuments({ periodId: period.id });
  const outcomes: DocumentOutcome[] = [];

  for (const doc of docs) {
    outcomes.push(await processDocument(doc.id, { force: options.force, index, actor }));
  }

  const count = (status: DocumentOutcome["status"]) =>
    outcomes.filter((o) => o.status === status).length;

  return {
    driveState: state,
    sync,
    total: outcomes.length,
    reused: count("reused"),
    computed: count("computed"),
    declined: count("declined"),
    failed: count("failed"),
    outcomes,
  };
}
