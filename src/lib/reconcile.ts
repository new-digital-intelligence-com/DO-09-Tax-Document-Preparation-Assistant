import "server-only";
import { createHash } from "node:crypto";
import { record } from "./audit";
import { documentViews, listDocuments } from "./documents";
import { listExtractions } from "./extract";
import { listLedger } from "./ledger";
import { getSettings, money } from "./settings";
import { mutate, readStore } from "./store";
import type { DocumentView, Extraction, LedgerEntry, Match, SourceDocument } from "./types";

/**
 * Reconciliation: which documents the ledger accounts for, and which it does
 * not.
 *
 * **No model call in this module, on purpose.** A pairing is an assertion that
 * this receipt is the payment on that ledger line, and it is the assertion the
 * whole exceptions list is built on. A model can produce a plausible pairing
 * for two rows that have nothing to do with each other, and nobody reviewing
 * the table afterwards can tell which pairings were reasoned and which were
 * confabulated. Scored arithmetic can be disagreed with, re-run, and explained
 * line by line — every `Match` carries the reasons that made it, including the
 * ones that stopped it.
 *
 * The scoring weights come from the build spec and are deliberately blunt:
 * exact amount 0.5, amount within 1% 0.3, dates within five days 0.2,
 * counterparty overlap up to 0.2, ledger ref equal to the invoice number 0.4.
 * Anything at 0.55 or above pairs. The weights are visible here rather than
 * tuned in a config, because a threshold nobody can find is a threshold nobody
 * questions.
 *
 * Nothing here writes to a `LedgerEntry` or to an `Extraction`. A mismatch is
 * recorded as a mismatch; making the two figures agree is not this app's to do.
 */

const THRESHOLD = 0.55;

const WEIGHTS = {
  amountExact: 0.5,
  amountClose: 0.3,
  date: 0.2,
  counterparty: 0.2,
  reference: 0.4,
};

/** Amounts differing by less than a cent are the same amount. */
const CENT = 0.01;
/** Days apart at which a date stops being evidence of anything. */
const DATE_WINDOW = 5;
/** Relative gap still counted as "close" — a rounding or a small fee. */
const CLOSE_FRACTION = 0.01;

const DAY_MS = 86_400_000;

/**
 * Whole days between two ISO dates, or nothing when either is missing or
 * malformed.
 *
 * Built from the date parts through `Date.UTC` rather than `new Date(string)`:
 * the latter reads a bare `YYYY-MM-DD` as midnight UTC but a `YYYY-MM-DDTHH`
 * as local time, and a document dated the 1st must not land on the 31st of the
 * month before because the server runs west of Greenwich.
 *
 * Exported because `exceptions.ts` needs the same answer for the backdating
 * check, and two implementations of "how far apart are these dates" would
 * eventually give two answers.
 */
export function daysBetween(a?: string, b?: string): number | undefined {
  const left = toUtc(a);
  const right = toUtc(b);
  if (left === undefined || right === undefined) return undefined;
  return Math.round((right - left) / DAY_MS);
}

function toUtc(date?: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((date ?? "").trim());
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Words that appear in half the counterparty names in any ledger and identify
 * none of them. Left in, "Acme Inc" and "Bolt Inc" share a token and score as
 * if they were the same trading name.
 */
const NOISE_TOKENS = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "plc",
  "sa",
  "the",
  "and",
  "group",
  "holdings",
  "services",
  "service",
  "payment",
  "invoice",
  "subscription",
  "monthly",
]);

function tokens(...parts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const part of parts) {
    for (const token of (part ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 3 && !NOISE_TOKENS.has(token)) out.add(token);
    }
  }
  return out;
}

function normaliseRef(value?: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A stable id for a pairing.
 *
 * Derived from what the pairing *is*, so re-running reconciliation leaves the
 * rows a reviewer was looking at with the ids they had. Random ids would
 * renumber the whole table on every run and make the audit trail unreadable —
 * "match mat_lz3k9 changed" says nothing when mat_lz3k9 no longer exists.
 */
function matchId(key: string): string {
  return `mat_${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

type Candidate = {
  doc: SourceDocument;
  extraction: Extraction;
  entry: LedgerEntry;
  score: number;
  reasons: string[];
  amountDelta?: number;
};

/**
 * Score one document against one ledger entry.
 *
 * Amounts are compared in absolute value. A ledger records money out as
 * positive on an expense account and money in as positive on an income one, so
 * a sign comparison would refuse to pair an invoice with the payment that
 * settled it — the sign is a property of the account, not evidence about the
 * pairing.
 */
function scorePair(
  doc: SourceDocument,
  extraction: Extraction,
  entry: LedgerEntry,
  currencyLabel: string,
): { score: number; reasons: string[]; amountDelta?: number } {
  const reasons: string[] = [];
  let score = 0;
  let amountDelta: number | undefined;

  const docTotal = extraction.total;
  const docCurrency = extraction.currency ?? currencyLabel;

  if (typeof docTotal === "number" && Number.isFinite(docTotal)) {
    const left = Math.abs(docTotal);
    const right = Math.abs(entry.amount);
    const delta = round(Math.abs(left - right));
    const larger = Math.max(left, right);

    if (delta < CENT) {
      score += WEIGHTS.amountExact;
      reasons.push(`Amount matches exactly at ${money(left, docCurrency)}.`);
    } else if (larger > 0 && delta / larger <= CLOSE_FRACTION) {
      score += WEIGHTS.amountClose;
      amountDelta = round(left - right);
      reasons.push(
        `Amounts within 1%: document ${money(left, docCurrency)}, ledger ` +
          `${money(right, entry.currency)}, a difference of ${money(delta, docCurrency)}.`,
      );
    } else {
      amountDelta = round(left - right);
      reasons.push(
        `Amounts differ: document ${money(left, docCurrency)}, ledger ` +
          `${money(right, entry.currency)}.`,
      );
    }
  } else {
    reasons.push("The extraction carries no total, so the amounts could not be compared.");
  }

  const gap = daysBetween(extraction.issueDate, entry.date);
  if (gap === undefined) {
    reasons.push("The document has no issue date, so the dates could not be compared.");
  } else if (Math.abs(gap) <= DATE_WINDOW) {
    score += WEIGHTS.date;
    reasons.push(
      Math.abs(gap) === 0
        ? `Both dated ${entry.date}.`
        : `Dated ${Math.abs(gap)} day(s) apart: document ${extraction.issueDate}, ledger ${entry.date}.`,
    );
  } else {
    reasons.push(
      `Dated ${Math.abs(gap)} day(s) apart: document ${extraction.issueDate}, ledger ${entry.date}.`,
    );
  }

  const docNames = tokens(extraction.vendor, doc.filename);
  const entryNames = tokens(entry.counterparty, entry.description);
  const shared = [...docNames].filter((token) => entryNames.has(token));
  if (shared.length > 0) {
    const smaller = Math.min(docNames.size, entryNames.size) || 1;
    const overlap = Math.min(1, shared.length / smaller);
    score += round(WEIGHTS.counterparty * overlap, 3);
    reasons.push(
      `Counterparty overlaps on ${shared.join(", ")} — document "${extraction.vendor ?? doc.filename}", ` +
        `ledger "${entry.counterparty}".`,
    );
  } else if (extraction.vendor || entry.counterparty) {
    reasons.push(
      `No shared words between "${extraction.vendor ?? doc.filename}" and "${entry.counterparty}".`,
    );
  }

  const ref = normaliseRef(entry.ref);
  const invoiceNumber = normaliseRef(extraction.invoiceNumber);
  if (ref && invoiceNumber && ref === invoiceNumber) {
    score += WEIGHTS.reference;
    reasons.push(`Ledger ref ${entry.ref} is the document's invoice number ${extraction.invoiceNumber}.`);
  }

  // The weights can add past 1 when everything agrees. A confidence is 0–1 by
  // its type; clamping keeps the table honest rather than showing 1.3.
  return { score: Math.min(1, round(score, 3)), reasons, amountDelta };
}

export async function listMatches(periodId: string): Promise<Match[]> {
  return (await readStore<Match[]>("matches", [])).filter((match) => match.periodId === periodId);
}

/**
 * Pair the period's documents against its ledger.
 *
 * Greedy, highest score first, one-to-one. Greedy rather than optimal because a
 * reviewer has to be able to answer "why did that receipt go to that line" in
 * one sentence, and "it was the best-scoring pair still available" is that
 * sentence. A global optimum can only be explained by the whole matrix.
 *
 * Documents with no extraction, or one that came back `unreadable` or `failed`,
 * are left out of the pairing entirely rather than reported as unmatched. A
 * `document-only` row asserts the ledger has nothing for this document, and
 * that assertion cannot be made about a page whose amount nobody has read. The
 * unreadable ones reach the reviewer through the exceptions list instead.
 */
export async function reconcile(
  periodId: string,
  actor: string,
): Promise<{
  matched: number;
  documentOnly: number;
  ledgerOnly: number;
  amountMismatches: number;
}> {
  const [settings, docs, extractions, entries] = await Promise.all([
    getSettings(),
    listDocuments({ periodId }),
    listExtractions(periodId),
    listLedger(periodId),
  ]);

  const currency = settings.currency;
  const extractionByDoc = new Map(extractions.map((row) => [row.docId, row]));

  const readable = docs
    .map((doc) => ({ doc, extraction: extractionByDoc.get(doc.id) }))
    .filter(
      (pair): pair is { doc: SourceDocument; extraction: Extraction } =>
        pair.extraction !== undefined && pair.extraction.status === "extracted",
    );
  const setAside = docs.length - readable.length;

  /**
   * Every document against every entry. Quadratic, and deliberately so: the
   * corpus is tens of documents against tens of ledger rows, and the full
   * matrix is what lets an *unmatched* row say which entry came closest and by
   * how much. A pre-filter would make the table faster and the explanation
   * empty.
   */
  const candidates: Candidate[] = [];
  const bestForDoc = new Map<string, Candidate>();
  const bestForEntry = new Map<string, Candidate>();

  for (const { doc, extraction } of readable) {
    for (const entry of entries) {
      const { score, reasons, amountDelta } = scorePair(doc, extraction, entry, currency);
      const candidate: Candidate = { doc, extraction, entry, score, reasons, amountDelta };
      if (score >= THRESHOLD) candidates.push(candidate);

      const docBest = bestForDoc.get(doc.id);
      if (!docBest || score > docBest.score) bestForDoc.set(doc.id, candidate);
      const entryBest = bestForEntry.get(entry.id);
      if (!entryBest || score > entryBest.score) bestForEntry.set(entry.id, candidate);
    }
  }

  // Ties break on the ids so two runs over the same data pair the same rows.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.doc.id.localeCompare(b.doc.id) ||
      a.entry.id.localeCompare(b.entry.id),
  );

  const usedDocs = new Set<string>();
  const usedEntries = new Set<string>();
  /** Who took each side, so an unmatched row can say what outbid it. */
  const tookEntry = new Map<string, SourceDocument>();
  const tookDoc = new Map<string, LedgerEntry>();
  const now = new Date().toISOString();
  const next: Match[] = [];
  let amountMismatches = 0;

  for (const candidate of candidates) {
    if (usedDocs.has(candidate.doc.id) || usedEntries.has(candidate.entry.id)) continue;
    usedDocs.add(candidate.doc.id);
    usedEntries.add(candidate.entry.id);
    tookEntry.set(candidate.entry.id, candidate.doc);
    tookDoc.set(candidate.doc.id, candidate.entry);

    const delta =
      candidate.amountDelta !== undefined && Math.abs(candidate.amountDelta) >= CENT
        ? candidate.amountDelta
        : undefined;
    if (delta !== undefined) amountMismatches++;

    next.push({
      id: matchId(`${periodId}|${candidate.doc.id}|${candidate.entry.id}`),
      periodId,
      kind: "matched",
      docId: candidate.doc.id,
      ledgerEntryId: candidate.entry.id,
      score: candidate.score,
      reasons: candidate.reasons,
      amountDelta: delta,
      matchedAt: now,
    });
  }

  for (const { doc } of readable) {
    if (usedDocs.has(doc.id)) continue;
    const closest = bestForDoc.get(doc.id);
    next.push({
      id: matchId(`${periodId}|doc|${doc.id}`),
      periodId,
      kind: "document-only",
      docId: doc.id,
      score: 0,
      reasons: closest
        ? [
            /**
             * A row can be left over for two different reasons, and saying the
             * wrong one sends a reviewer looking in the wrong place. Either
             * nothing scored high enough, or something did and a
             * better-scoring document took it — one-to-one pairing means the
             * second happens whenever two documents chase one payment.
             */
            closest.score >= THRESHOLD && usedEntries.has(closest.entry.id)
              ? `The best-scoring entry, ${closest.entry.id} at ${closest.score}, was paired with ` +
                `${tookEntry.get(closest.entry.id)?.filename ?? "another document"} instead.`
              : `Nothing in the ${entries.length}-row ledger scored ${THRESHOLD} or above.`,
            `Closest was ${closest.entry.id} — ${closest.entry.counterparty || "no counterparty"}, ` +
              `${money(closest.entry.amount, closest.entry.currency)} on ${closest.entry.date} — ` +
              `at ${closest.score}.`,
            ...closest.reasons,
          ]
        : [
            entries.length === 0
              ? "No ledger has been imported for this period, so nothing could be matched."
              : "No ledger entry scored above zero against this document.",
          ],
      matchedAt: now,
    });
  }

  for (const entry of entries) {
    if (usedEntries.has(entry.id)) continue;
    const closest = bestForEntry.get(entry.id);
    next.push({
      id: matchId(`${periodId}|led|${entry.id}`),
      periodId,
      kind: "ledger-only",
      ledgerEntryId: entry.id,
      score: 0,
      reasons: closest
        ? [
            closest.score >= THRESHOLD && usedDocs.has(closest.doc.id)
              ? `The best-scoring document, ${closest.doc.filename} at ${closest.score}, was paired ` +
                `with ${tookDoc.get(closest.doc.id)?.id ?? "another entry"} instead.`
              : `No document among the ${readable.length} read so far scored ${THRESHOLD} or above.`,
            `Closest was ${closest.doc.filename} (${closest.doc.id}) at ${closest.score}.`,
            ...closest.reasons,
          ]
        : [
            readable.length === 0
              ? "No document in this period has been extracted yet, so nothing could be matched."
              : "No document scored above zero against this entry.",
          ],
      matchedAt: now,
    });
  }

  await mutate<Match[], void>("matches", [], (all) => ({
    // Matches are derived data: the period's set is replaced wholesale so a
    // pairing that no longer holds cannot survive a re-run.
    next: [...all.filter((match) => match.periodId !== periodId), ...next],
    result: undefined,
  }));

  const matched = next.filter((match) => match.kind === "matched").length;
  const documentOnly = next.filter((match) => match.kind === "document-only").length;
  const ledgerOnly = next.filter((match) => match.kind === "ledger-only").length;

  await record({
    actor,
    action: "reconcile.run",
    subject: periodId,
    result: "ok",
    detail:
      `Reconciled ${readable.length} readable document(s) against ${entries.length} ledger ` +
      `row(s): ${matched} matched (${amountMismatches} of them on differing amounts), ` +
      `${documentOnly} document(s) with no ledger entry, ${ledgerOnly} ledger row(s) with no ` +
      `document.` +
      (setAside > 0
        ? ` ${setAside} document(s) were set aside as not yet readable and are not counted as ` +
          `unmatched.`
        : "") +
      ` Nothing in the ledger was changed. Re-run detection to refresh the exceptions.`,
    periodId,
  });

  return { matched, documentOnly, ledgerOnly, amountMismatches };
}

/**
 * The reconciliation table, joined up for display.
 *
 * Ordered by what needs a person first: paired rows whose amounts disagree,
 * then the rest of the pairs; unsupported ledger rows and unaccounted-for
 * documents largest first. A reviewer working down the list from the top spends
 * their attention on the biggest gap rather than on whatever sorted first
 * alphabetically.
 */
export async function reconciliationSummary(periodId: string): Promise<{
  matched: { match: Match; doc?: DocumentView; entry?: LedgerEntry }[];
  documentOnly: { match: Match; doc: DocumentView }[];
  ledgerOnly: { match: Match; entry: LedgerEntry }[];
}> {
  const [matches, views, entries] = await Promise.all([
    listMatches(periodId),
    documentViews(periodId),
    listLedger(periodId),
  ]);

  const viewByDoc = new Map(views.map((view) => [view.doc.id, view]));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  const matched = matches
    .filter((match) => match.kind === "matched")
    .map((match) => ({
      match,
      doc: match.docId ? viewByDoc.get(match.docId) : undefined,
      entry: match.ledgerEntryId ? entryById.get(match.ledgerEntryId) : undefined,
    }))
    .sort(
      (a, b) =>
        Number(b.match.amountDelta !== undefined) - Number(a.match.amountDelta !== undefined) ||
        Math.abs(b.match.amountDelta ?? 0) - Math.abs(a.match.amountDelta ?? 0) ||
        (a.entry?.date ?? "").localeCompare(b.entry?.date ?? ""),
    );

  /**
   * A row whose other half is missing is dropped from the display rather than
   * shown half-empty. It means a document was deleted or a ledger cleared since
   * the last run, and the honest reading of that is "this reconciliation is
   * stale", which the console says by showing fewer rows than there are
   * documents — not by rendering a pairing with a blank on one side.
   */
  const documentOnly = matches
    .filter((match) => match.kind === "document-only")
    .flatMap((match) => {
      const doc = match.docId ? viewByDoc.get(match.docId) : undefined;
      return doc ? [{ match, doc }] : [];
    })
    .sort(
      (a, b) =>
        (b.doc.extraction?.total ?? 0) - (a.doc.extraction?.total ?? 0) ||
        a.doc.doc.filename.localeCompare(b.doc.doc.filename),
    );

  const ledgerOnly = matches
    .filter((match) => match.kind === "ledger-only")
    .flatMap((match) => {
      const entry = match.ledgerEntryId ? entryById.get(match.ledgerEntryId) : undefined;
      return entry ? [{ match, entry }] : [];
    })
    .sort(
      (a, b) =>
        Math.abs(b.entry.amount) - Math.abs(a.entry.amount) || a.entry.date.localeCompare(b.entry.date),
    );

  return { matched, documentOnly, ledgerOnly };
}
