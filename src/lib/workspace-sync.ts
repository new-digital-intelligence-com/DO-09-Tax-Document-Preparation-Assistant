import "server-only";
import { createHash } from "node:crypto";
import { record } from "./audit";
import { categoryName } from "./categories";
import { classifyDocument, getClassification } from "./classify";
import { getDocument, ingestMany, listDocuments, removeDocument } from "./documents";
import {
  downloadFile,
  driveStatus,
  findInFolder,
  listFolder,
  putJson,
  readTextFile,
  trashFile,
  workspace,
} from "./drive";
import { extractDocument } from "./extract";
import { activePeriod, preparer } from "./settings";
import { readStore, writeStore } from "./store";
import { effectiveCategoryId } from "./types";
import type { Classification, Extraction, SourceDocument } from "./types";

/**
 * A per-document result cache on top of a store that already lives on Drive.
 *
 * `store.ts` already reads and writes the period's register — documents,
 * extractions, classifications — straight from Drive on every call; nothing
 * in this app keeps a local copy of anything. This module adds one more thing
 * on top of that: `output/<sha256>.json`, a cache keyed by the CONTENT of a
 * document rather than by which period or which run produced it.
 *
 * The reason that is worth a second file rather than just relying on the
 * period register: reading a document costs a model call per page, and
 * categorising it costs a share of another. A document already read once —
 * in this period, in a different one, from a different machine's session —
 * should never be paid for again, and content-hash keying is what makes that
 * true regardless of which document row, which filename, or which period it
 * turns up under next.
 *
 * What this deliberately does NOT cache is anything downstream of one
 * document. The exception list and the draft forms are computed over the
 * whole period from the register directly and are cheap to recompute; caching
 * them here would mean a stale finding surviving a change to the document it
 * was raised against.
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

/**
 * One thing that happened while a document was being processed, as it happens.
 *
 * The pipeline is four network round trips and the better part of half a
 * minute, and for all of that time the only thing a person could previously
 * see was a spinner. That is not a cosmetic problem: somebody who cannot tell
 * whether their file arrived goes looking for it, uploads it again, or decides
 * the app is broken. These are emitted as each stage begins and ends, so the
 * console can show what is actually being done rather than that something is.
 *
 * `detail` carries the finding, not a status word — "Anthropic, PBC · $105.00"
 * rather than "extraction complete". A progress line that says nothing about
 * the document is a progress line nobody reads twice.
 */
export type ProcessStep = {
  stage: "cache" | "reading" | "read" | "declined" | "categorising" | "categorised" | "saving" | "done";
  label: string;
  detail?: string;
  /** Set when this step is the end of the road for the document. */
  terminal?: boolean;
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

/**
 * Throw away what was cached for a document's contents.
 *
 * This is what makes a deletion stick. The cache is keyed by the hash of the
 * file's bytes, not by the document id, so a delete that left the cached
 * result behind would be undone by the next upload of the same file: it would
 * come straight back with the old vendor, the old total and the old category,
 * having never been read again. To anyone watching, the deletion simply did
 * not happen.
 *
 * Returns whether anything was actually there — a document deleted before it
 * was ever read has no cached result, and that is not a failure.
 */
export async function dropCachedResult(sha256: string): Promise<boolean> {
  if (!sha256) return false;
  try {
    const folders = await workspace();
    const hit = await findInFolder(folders.outputId, resultName(sha256));
    if (!hit) return false;
    await trashFile(hit.id, [folders.outputId]);
    return true;
  } catch {
    // A cached result that could not be trashed leaves a stale file in
    // `output/`, which is a Drive-side tidy-up. It is not a reason to fail the
    // deletion the person asked for, and the register no longer lists the
    // document either way.
    return false;
  }
}

/**
 * Delete a document and everything the workspace holds because of it.
 *
 * This is the one entry point for "get rid of it". `removeDocument` clears the
 * register — the row, its extraction, its categorisation, the findings that
 * were only about it — and trashes the file in `input/`. What it cannot reach
 * is the cached result in `output/`, because the cache lives up here.
 *
 * Both halves are needed, and the cache is the half people forget. It is keyed
 * by the hash of the file's bytes, so a deletion that left it behind would be
 * silently reversed by the next upload of the same file: it would return with
 * the old vendor, the old total and the old category, having never been read
 * again. The delete would look like it had not happened.
 *
 * The register is cleared first. If clearing the cache then fails, the outcome
 * is a stale file in `output/` and a document that is genuinely gone — the
 * recoverable failure. Doing it the other way round risks a document still on
 * the register whose cached result has been thrown away, which silently costs
 * a model call to rebuild something that was already correct.
 */
export async function purgeDocument(
  id: string,
  actor: string,
  reason: string,
): Promise<{ id: string; filename: string; sha256: string; cacheCleared: boolean }> {
  const doc = await getDocument(id);
  if (!doc) throw new Error(`No document ${id} on the register.`);

  await removeDocument(id, actor, reason);
  const cacheCleared = await dropCachedResult(doc.sha256);

  if (cacheCleared) {
    await record({
      actor,
      action: "document.cache.cleared",
      subject: doc.id,
      result: "ok",
      detail:
        `Removed output/${resultName(doc.sha256)}, the cached reading of ${doc.filename}. ` +
        `Uploading the same file again will read it afresh rather than restoring these figures.`,
      periodId: doc.periodId,
      docId: doc.id,
    });
  }

  return { id: doc.id, filename: doc.filename, sha256: doc.sha256, cacheCleared };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Applying a cached result locally
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Put cached extractions and categorisations into the register, in one write
 * of each collection regardless of how many documents are being applied.
 *
 * The `docId` on a cached row belongs to whichever run first produced it, so
 * every row is rewritten to this workspace's id before it goes in — without
 * that, the row is stored against a document that does not exist here and
 * every join downstream silently drops it.
 *
 * Called with one entry for a single document (`processDocument`'s cache hit)
 * or with dozens at once (`hydrateFromDrive` catching a whole workspace up).
 * Either way it costs one read and one write per collection, never one pair
 * per document — the same reasoning as `ingestMany`, applied to the other
 * place a bulk operation used to mean rewriting a growing register once per
 * item.
 */
async function applyCachedMany(rows: { docId: string; cached: CachedResult }[]): Promise<void> {
  if (rows.length === 0) return;

  const withExtraction = rows.filter((row): row is { docId: string; cached: CachedResult & { extraction: Extraction } } =>
    Boolean(row.cached.extraction),
  );
  if (withExtraction.length > 0) {
    const existing = await readStore<Extraction[]>("extractions", []);
    const incoming = new Map(withExtraction.map((row) => [row.docId, { ...row.cached.extraction, docId: row.docId }]));
    const next = [
      ...existing.filter((row) => !incoming.has(row.docId)),
      ...incoming.values(),
    ].sort((a, b) => a.docId.localeCompare(b.docId));
    await writeStore("extractions", next);
  }

  const withClassification = rows.filter(
    (row): row is { docId: string; cached: CachedResult & { classification: Classification } } =>
      Boolean(row.cached.classification),
  );
  if (withClassification.length > 0) {
    const existing = await readStore<Classification[]>("classifications", []);
    const incoming = new Map(
      withClassification.map((row) => [row.docId, { ...row.cached.classification, docId: row.docId }]),
    );
    const next = [
      ...existing.filter((row) => !incoming.has(row.docId)),
      ...incoming.values(),
    ].sort((a, b) => a.docId.localeCompare(b.docId));
    await writeStore("classifications", next);
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
  options: {
    force?: boolean;
    index?: CacheIndex;
    actor?: string;
    /**
     * Called as each stage begins and ends. Failing to report progress must
     * never fail the work, so anything thrown in here is swallowed — a
     * disconnected browser is the common case and the document should still
     * finish being read.
     */
    onStep?: (step: ProcessStep) => void | Promise<void>;
  } = {},
): Promise<DocumentOutcome> {
  const actor = options.actor ?? preparer();

  const step = async (value: ProcessStep) => {
    try {
      await options.onStep?.(value);
    } catch {
      // See above: the reader going away is not the document's problem.
    }
  };

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
    await step({
      stage: "cache",
      label: "Checking whether this was read before",
      detail: `Looking for ${doc.sha256.slice(0, 12)}… in the Drive output folder`,
    });
    const cached = await readCachedResult(doc.sha256, options.index);
    if (cached?.extraction) {
      await applyCachedMany([{ docId, cached }]);
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
      await step({
        stage: "done",
        label: "Already read once — restored from Drive",
        detail:
          `${cached.extraction.vendor ?? "Vendor not read"} · processed ` +
          `${cached.processedAt.slice(0, 10)}. No model call was made.`,
        terminal: true,
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
  await step({
    stage: "reading",
    label: "Reading the page",
    detail: `Sending ${doc.filename} to the model to pull out vendor, dates and amounts`,
  });

  let extraction: Extraction;
  try {
    extraction = await extractDocument(docId, actor);
  } catch (error) {
    await step({
      stage: "done",
      label: "Could not be read",
      detail: error instanceof Error ? error.message : "The document could not be read.",
      terminal: true,
    });
    return {
      ...base,
      status: "failed",
      detail: error instanceof Error ? error.message : "The document could not be read.",
    };
  }

  // 3. A document that is not a financial record is declined rather than
  //    forced onto the chart. It stays on the register with its reason so the
  //    person who uploaded it can see what happened to it.
  if (extraction.status === "extracted") {
    const money =
      typeof extraction.total === "number"
        ? `${extraction.currency ?? ""} ${extraction.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim()
        : "no total found";
    await step({
      stage: "read",
      label: "Read it",
      detail: [extraction.vendor ?? "vendor not found", money, extraction.issueDate]
        .filter(Boolean)
        .join(" · "),
    });
  }

  if (extraction.status === "out-of-scope") {
    await step({
      stage: "declined",
      label: "Not a financial document — withdrawn",
      detail: extraction.statusDetail ?? "Nothing on the page is an invoice, receipt or statement.",
      terminal: true,
    });
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
  await step({
    stage: "categorising",
    label: "Choosing a tax category",
    detail: "Matching what was read against the chart of categories",
  });

  let classification: Classification | undefined;
  try {
    classification = await classifyDocument(docId, actor);
  } catch {
    // A categorisation that failed leaves a readable extraction in place. The
    // document shows as read but unsorted, which is true and recoverable.
    classification = await getClassification(docId);
  }

  await step({
    stage: "categorised",
    label: classification ? "Categorised" : "Could not categorise it",
    detail: classification
      ? `${categoryName(effectiveCategoryId(classification))}` +
        `${classification.needsReview ? " — flagged for a person to confirm" : ""}`
      : "It stays on the register as read but unsorted.",
  });

  // 5. Write the answer back so the next run does not pay for it again.
  let storedToDrive = false;
  if (driveReady) {
    await step({
      stage: "saving",
      label: "Saving the result to Drive",
      detail: "So this document is never read twice",
    });
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

  await step({
    stage: "done",
    label: extraction.status === "extracted" ? "Done" : "Finished with problems",
    detail:
      extraction.status === "extracted"
        ? `${doc.filename} is on the register${storedToDrive ? " and saved to Drive" : ""}.`
        : (extraction.statusDetail ?? `Came back ${extraction.status}.`),
    terminal: true,
  });

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
  let alreadyHeld = 0;

  /**
   * Every unfamiliar file's bytes are pulled down first, and NOTHING is
   * written to the register until every one of them is in hand. That is what
   * lets `ingestMany` turn what could be dozens of individual reads and
   * rewrites of the register into exactly one of each — a sweep that finds
   * forty new files no longer means reading and rewriting a growing register
   * forty separate times.
   */
  const toIngest: Parameters<typeof ingestMany>[0] = [];

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

    toIngest.push({
      filename: file.name,
      bytes,
      mimeType: file.mimeType,
      source: "drive",
      sourceRef: file.id,
      sourceDetail: `Drive · input/${file.name}`,
      periodId: period.id,
      actor,
    });
  }

  await ingestMany(toIngest);
  const ingested = toIngest.length;

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
 * Bring a newly opened workspace's register up to date with Drive, at no cost.
 *
 * Two gaps this closes, both real even though the register itself already
 * lives on Drive rather than anywhere local.
 *
 * First: a file sitting in the Drive `input` folder is not automatically a
 * row in `state/documents.json` — someone may have dropped it there directly,
 * through Drive itself or a Gmail forward, without this app ever being asked
 * to collect it. `syncFromDrive` is what turns "a file is in the folder" into
 * "the register has a row for it".
 *
 * Second: a document already read somewhere — a different period, a
 * different session — has its answer sitting in `output/<sha256>.json`, but
 * THIS period's `state/extractions.json` has no row pointing at it until
 * something copies it across. That is what `applyCached` does here.
 *
 * Neither step ever calls the model. Anything with no cached answer in
 * `output/` is left unread rather than paid for every time a workspace is
 * opened — that cost belongs to a deliberate Run, not to switching tabs.
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

  // Every cache hit is collected before anything is written, so catching up
  // a workspace with thirty-eight already-processed documents costs one read
  // and one write of the register — not thirty-eight of each.
  const toApply: { docId: string; cached: CachedResult }[] = [];
  for (const doc of docs) {
    if (alreadyRead.has(doc.id)) continue;
    const cached = await readCachedResult(doc.sha256, index);
    if (!cached?.extraction) continue;
    toApply.push({ docId: doc.id, cached });
  }
  await applyCachedMany(toApply);
  const applied = toApply.length;

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
