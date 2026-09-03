import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { record } from "./audit";
import {
  MODEL,
  PDF_LIMITS,
  TOKEN_BUDGET,
  explainModelError,
  extractFromDocument,
  modelConfigured,
} from "./anthropic";
import { getDocument, listDocuments, readDocumentBytes } from "./documents";
import { activePeriod, getPeriod, money } from "./settings";
import { mutate, readStore } from "./store";
import type { DocumentKind, Extraction, FilingPeriod, LineItem, SourceDocument } from "./types";

/**
 * Reading one document.
 *
 * This is the step where a wrong number gets born. Everything after it —
 * categorisation, the Schedule C draft — is arithmetic over
 * whatever lands here, and arithmetic cannot tell a figure that was read from
 * a figure that was inferred. So the whole design of this module is about
 * refusing to produce the second kind:
 *
 *   - the answer comes back through a forced tool call, so a number reaches
 *     the store having passed a schema rather than a regular expression;
 *   - `unreadable` is a first-class result with its own count, not an error
 *     path, because a scan nobody could read must appear on the flag list with
 *     its filename rather than vanish from the corpus and leave the totals
 *     looking clean;
 *   - every field is optional except the ones that describe the reading
 *     itself. An omitted vendor is a question for a reviewer. A plausible one
 *     is a wrong answer wearing a confidence score.
 *
 * Extraction is derived data, not a record of a decision, so re-extracting a
 * document overwrites its row. The audit trail is where the history lives: one
 * event per run, naming the figure that was replaced.
 */

/** The `DocumentKind` union as a runtime list, so the tool enum and the validator cannot drift. */
const DOC_KINDS: DocumentKind[] = [
  "invoice-issued",
  "invoice-received",
  "receipt",
  "credit-note",
  "statement",
  "bank-statement",
  "payout-report",
  "mileage-log",
  "contract",
  "other",
  "unknown",
];

/**
 * The media types the Messages API will accept as a page.
 *
 * Anything else is a failed extraction with a reason, never a silent skip: a
 * `.docx` invoice dropped from the run is money missing from the draft that
 * nothing on screen accounts for.
 */
const MEDIA_TYPES: Record<string, "application/pdf" | "image/png" | "image/jpeg"> = {
  "application/pdf": "application/pdf",
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
};

/* ────────────────────────────────────────────────────────────────────────────
 * The tool
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The schema is the contract with the model.
 *
 * Every money field is typed `number` and every date is a `YYYY-MM-DD` string,
 * so "1,842.19" and "4th March" are rejected before they reach a total rather
 * than being parsed into one by guesswork here. `status` is required and
 * enumerated: there is no shape of answer in which the model reports figures
 * without also saying whether it could read them.
 *
 * Almost nothing else is required. A required `total` would mean a document
 * with no legible total comes back with an invented one, which is the exact
 * failure this whole module exists to prevent.
 */
export const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_document",
  description:
    "Record what is legibly printed on one financial document. Report only what is on the " +
    "page. Leave out any field you cannot read — an omitted field is correct and useful, an " +
    "invented one is not.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["extracted", "unreadable", "out-of-scope"],
        description:
          "'extracted' when you could read the figures on the page. 'unreadable' when the page " +
          "holds financial content you could not make out — a blank or failed scan, a " +
          "photograph too dark or too skewed to read, digits that could be several things. " +
          "'out-of-scope' when the page is not a financial record at all: a photograph, a CV, a " +
          "letter, a screenshot, an article, a form with no money on it. Both are correct and " +
          "expected answers, and they are not interchangeable — 'unreadable' asks somebody for " +
          "a better copy, 'out-of-scope' tells whoever supplied the file that it is not one.",
      },
      statusDetail: {
        type: "string",
        description:
          "Required in spirit when status is not 'extracted'. On 'unreadable', say what you " +
          "could see, in one or two sentences: 'a one-page scan, heavily skewed, with a logo at " +
          "the top left and no legible digits' is useful, 'could not read' is not. On " +
          "'out-of-scope', say what the document appears to be, in one sentence — 'a photograph " +
          "of a beach with no text on it', 'a two-page CV'. The person who supplied the file is " +
          "shown this sentence and nothing else, so it has to answer why it came back.",
      },
      docType: {
        type: "string",
        enum: DOC_KINDS,
        description:
          "What the document is. 'invoice-issued' is one this business sent to a client; " +
          "'invoice-received' is one a supplier sent to this business. Use 'unknown' when the " +
          "page does not say — do not infer it from who you assume the parties are.",
      },
      direction: {
        type: "string",
        enum: ["expense", "income", "unknown"],
        description:
          "'expense' when this business is paying, 'income' when it is being paid, 'unknown' " +
          "when the page does not make it clear. This decides the sign on a tax form line.",
      },
      vendor: {
        type: "string",
        description:
          "The OTHER party, exactly as printed — never the business this return is being " +
          "prepared for. On a bill received it is the supplier whose name heads the page; on " +
          "an invoice we issued it is the client being billed. Not the filename, not an " +
          "expansion of a logo you recognise but cannot read, and not our own name used to " +
          "fill the field when the page names no second party.",
      },
      vendorTaxId: {
        type: "string",
        description:
          "The counterparty's EIN, VAT number or other tax identifier, only if it is printed.",
      },
      vendorAddress: { type: "string", description: "The counterparty's address as printed." },
      invoiceNumber: {
        type: "string",
        description: "The document's own reference or invoice number, exactly as printed.",
      },
      issueDate: {
        type: "string",
        description:
          "The date printed on the document, as YYYY-MM-DD. If the document writes a date in " +
          "an ambiguous form such as 03/04/2025 and nothing on the page settles which is the " +
          "month, omit this field rather than pick one.",
      },
      dueDate: { type: "string", description: "Payment due date, as YYYY-MM-DD, if printed." },
      periodStart: {
        type: "string",
        description:
          "Start of the service period the document covers, as YYYY-MM-DD, if it states one.",
      },
      periodEnd: {
        type: "string",
        description:
          "End of the service period the document covers, as YYYY-MM-DD, if it states one.",
      },
      currency: {
        type: "string",
        description:
          "Three-letter ISO code for the currency printed on the document — USD, EUR, GBP. " +
          "The currency on the page, never the one the accounts are kept in.",
      },
      subtotal: {
        type: "number",
        description: "Net amount before tax, as a number. No currency symbol, no thousands separator.",
      },
      tax: { type: "number", description: "Tax or VAT charged, as a number." },
      taxRate: {
        type: "number",
        description: "The tax rate as printed, if the document states one. Do not compute it.",
      },
      total: {
        type: "number",
        description:
          "The total amount payable as printed on the document, as a number. If subtotal and " +
          "tax do not add up to it, report all three as printed — the discrepancy is a finding " +
          "for a reviewer and correcting it here destroys it.",
      },
      lineItems: {
        type: "array",
        description:
          "The itemised lines, where the document has them. An empty array is correct for a " +
          "card receipt with a single figure on it.",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "The line as printed." },
            quantity: { type: "number" },
            unitPrice: { type: "number" },
            amount: { type: "number", description: "The line amount, as a number." },
          },
          required: ["description"],
        },
      },
      paymentMethod: {
        type: "string",
        description: "How it was paid, if stated — 'Visa', 'ACH', 'bank transfer', 'cash'.",
      },
      paymentLast4: {
        type: "string",
        description: "The last four digits of the card, only if they are printed on the page.",
      },
      confidence: {
        type: "number",
        description:
          "0 to 1: how sure you are that the characters you reported are the characters on the " +
          "page. This is a reading confidence and nothing else — not how typical the document " +
          "looks, not how well it fits any category. A clean born-digital invoice is near 1. A " +
          "legible but smudged scan is around 0.6. Report the low number when it is the true " +
          "one; a person is reading these.",
      },
      notes: {
        type: "string",
        description:
          "Anything a reviewer would want to know and no other field carries: a handwritten " +
          "amendment, a second currency shown alongside the first, a PAID stamp, a page that " +
          "is plainly one of several, a total that does not agree with its own line items.",
      },
    },
    required: ["status", "docType", "direction", "confidence", "lineItems"],
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * The prompt
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The system prompt.
 *
 * Written at length on purpose. Every rule in it names a specific way a wrong
 * figure reaches a tax form, because a model told "be accurate" and a model
 * told "a total taken off a filename cannot be told apart from one you read"
 * behave differently on a bad scan.
 */
const EXTRACTION_SYSTEM = [
  "You read one financial document and report what is printed on it. Nothing else.",
  "",
  "You are the first step in preparing a draft tax return. Every figure you report is added",
  "to a category total, lands on a form line, and is read by a tax professional who signs the",
  "return. On that form, a figure you were unsure of and reported anyway looks exactly like a",
  "figure you read cleanly. There is no later step that can tell them apart.",
  "",
  "The rules, in order of importance.",
  "",
  "1. Never invent. An omitted field beats a plausible one. If a field is not legible on the",
  "   page, leave it out. Do not complete a partial number, do not reconstruct a total from",
  "   line items, and do not supply a date, a vendor or an invoice number because a document",
  "   of this kind usually has one. An empty field is a question a person can answer. A",
  "   plausible one is a wrong answer nobody will think to check.",
  "",
  "2. The filename is not evidence. It was typed by whoever saved the file, and it is",
  "   frequently wrong, out of date, or copied from another document. Never take a vendor, a",
  "   total, a date, an invoice number or a currency from it. A total guessed off a filename",
  "   reaches a tax form with a confidence score attached to it, and that is the single worst",
  "   thing this system can produce.",
  "",
  "3. 'unreadable' is a real answer and often the right one. If the page carries no legible",
  "   figures, set status to unreadable and say in statusDetail what you could see. A document",
  "   reported unreadable is put in front of a person with its filename. A document guessed at",
  "   is not. Choosing unreadable is never a failure on your part.",
  "",
  "4. Scope, and the bar is low. Anyone can upload anything here, so you also decide whether",
  "   the page is a financial record at all. The question is NOT 'is this an invoice'. It is",
  "   'would a tax preparer use anything on this page'. All of these are in scope and must be",
  "   read: invoices sent and received, receipts of every kind including a photograph of a till",
  "   roll, credit notes, bank and card statements, payment-processor payout reports, mileage",
  "   logs, expense claims, insurance schedules, contracts that state fees, subscription",
  "   renewals, tax notices and assessments. A document does not need a total to be in scope —",
  "   a mileage log has no money on it and belongs here.",
  "",
  "   Set 'out-of-scope' only when the page plainly is not financial and re-scanning it would",
  "   not help: a holiday photograph, a CV, a news article, a screenshot of a conversation, a",
  "   personal letter, a menu nobody was billed for. Say what it appears to be in statusDetail.",
  "",
  "   When you are unsure, READ IT. The two mistakes are not equal. A page wrongly declined is a",
  "   deduction that silently never reaches the return, and nobody reviews a document you said",
  "   was irrelevant. A page wrongly read is a row on a list a person is already checking.",
  "",
  "5. Report the document as it stands, not as it ought to be. If the subtotal plus the tax",
  "   does not equal the printed total, report all three as printed. If the document",
  "   contradicts itself, report the contradiction in notes. Adjusting a figure so the",
  "   arithmetic works destroys the finding that a reviewer needed to see.",
  "",
  "6. Currency is the code printed on the document. Never the one you would expect, and never",
  "   converted. A figure in the wrong currency is flagged downstream; a figure silently",
  "   converted is not flagged at all.",
  "",
  "7. confidence is your reading confidence: how sure you are that the characters you reported",
  "   are the characters on the page. It is not how ordinary the document looks and not how",
  "   neatly it fits a category. Report the low number when it is the true one.",
  "",
  "8. Put anything else a reviewer would want in notes. Nothing you notice is suppressed.",
  "",
  "You do not categorise the document, you do not judge whether anything is deductible, and",
  "you do not give tax advice. A later step categorises and a person decides.",
].join("\n");

/** The per-document question. The period is context, never something to fit the answer to. */
function instructionFor(doc: SourceDocument, period: FilingPeriod): string {
  return [
    "Read this document and record what is printed on it.",
    "",
    `The file is named "${doc.filename}" and was collected from ${doc.source}` +
      `${doc.sourceDetail ? ` (${doc.sourceDetail})` : ""}. The name is there because you can`,
    "see it on the document block; it is not evidence. Take every field from the page itself.",
    "",
    // Naming the entity is not context, it is the answer to a question the page
    // cannot settle on its own. An invoice has two parties on it, and without
    // knowing which one is us, "the counterparty" has two equally readable
    // answers — the issuer at the top and the addressee under "invoice to".
    // Getting it backwards is quiet and expensive: contract-labour totals end
    // up attributed to ourselves, so the 1099 summary lists the wrong payee and
    // the reporting-threshold check runs against the wrong person.
    `The tax return being prepared is for ${period.entity}. That is us, the reader of this`,
    "document, and we are never the vendor.",
    "",
    `- If ${period.entity} appears under "bill to", "invoice to", "sold to", "ship to" or as`,
    "  the recipient of a receipt, then somebody billed us. `vendor` is the OTHER party — the",
    "  business whose name and address head the page — and `direction` is \"expense\".",
    `- If ${period.entity} is the issuer, whose name and address head the page, then we billed`,
    "  somebody. `vendor` is the client being billed and `direction` is \"income\".",
    `- Either way, never report ${period.entity} as the vendor. If the page genuinely names no`,
    "  second party, leave `vendor` out rather than falling back to us.",
    "- On a statement, a payout report or a mileage log there may be no counterparty at all.",
    "  Leave `vendor` out; do not put our own name there to fill the field.",
    "",
    `For context only: the filing period being prepared is ${period.label}, ${period.start} to`,
    `${period.end}, reported in ${period.currency}. Do not adjust, convert or shift anything to`,
    "fit that period or that currency. A document dated outside the period, or priced in",
    "another currency, is a finding for a reviewer — report it exactly as printed.",
  ].join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the store
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Extractions, optionally narrowed to one period.
 *
 * An extraction row carries only a `docId`, so the period filter is a join
 * against the document register rather than a field test. Sorted by `docId` so
 * two runs over the same corpus hand callers the same order, so a re-run does
 * not reshuffle a screen somebody is reading.
 */
export async function listExtractions(periodId?: string): Promise<Extraction[]> {
  const rows = await readStore<Extraction[]>("extractions", []);
  if (!periodId) return [...rows].sort((a, b) => a.docId.localeCompare(b.docId));

  const inScope = new Set((await listDocuments({ periodId })).map((doc) => doc.id));
  return rows
    .filter((row) => inScope.has(row.docId))
    .sort((a, b) => a.docId.localeCompare(b.docId));
}

export async function getExtraction(docId: string): Promise<Extraction | undefined> {
  return (await readStore<Extraction[]>("extractions", [])).find((row) => row.docId === docId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalising the model's answer
 * ────────────────────────────────────────────────────────────────────────── */

/** Trimmed, or absent. An empty string in a vendor field renders as a blank cell nobody can act on. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A number, or nothing.
 *
 * The schema asks for a number and the model usually sends one, but a tool
 * input is not validated against `type: "number"` strictly enough to rely on,
 * and "1,842.19" or "$1,842.19" is a figure that was genuinely read — stripping
 * grouping and a leading symbol is not inference. Anything that still is not a
 * number is dropped: a total nobody can parse must be absent, not zero. Zero is
 * a figure, and it would quietly reduce a category total.
 */
function amount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\s,]/g, "").replace(/^[^\d.\-+]+/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * An ISO `YYYY-MM-DD` date, or nothing.
 *
 * Nothing here tries to rescue another format. "03/04/2025" is March in one
 * country and April in another, and picking one puts a document in the wrong
 * quarter — which is a filing error, not a display error. An absent date is
 * visible on the console and answerable by anyone holding the document.
 */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const day = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [, month, dayOfMonth] = day.split("-").map(Number);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  return day;
}

/** A three-letter code, uppercased. Anything else is not a currency and is dropped. */
function currencyCode(value: unknown): string | undefined {
  const raw = text(value)?.toUpperCase();
  return raw && /^[A-Z]{3}$/.test(raw) ? raw : undefined;
}

/**
 * A 0–1 confidence.
 *
 * An unparseable or absent confidence becomes 0, not 1. The whole point of the
 * field is to raise a flag, and a default that clears the threshold turns a
 * malformed answer into a document nobody looks at. A value above 1 is read as
 * a percentage, because clamping 85 to 1 would do exactly that.
 */
function fraction(value: unknown): number {
  const parsed = amount(value);
  if (parsed === undefined) return 0;
  const scaled = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, scaled));
}

/** Line items with something in the description. A row reading only "12.00" tells a reviewer nothing. */
function lineItemsOf(value: unknown): LineItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const description = text(row.description);
      if (!description) return undefined;
      const item: LineItem = { description };
      const quantity = amount(row.quantity);
      const unitPrice = amount(row.unitPrice);
      const lineAmount = amount(row.amount);
      if (quantity !== undefined) item.quantity = quantity;
      if (unitPrice !== undefined) item.unitPrice = unitPrice;
      if (lineAmount !== undefined) item.amount = lineAmount;
      return item;
    })
    .filter((item): item is LineItem => item !== undefined);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = text(value);
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Compare two business names ignoring the parts that are not the name.
 *
 * "Northwind Studio LLC", "northwind studio", and "Northwind Studio, L.L.C."
 * are one company. Legal suffixes, punctuation and case all vary between the
 * letterhead, the footer and the settings file, and none of that variation
 * means a different party.
 */
const LEGAL_SUFFIX = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|llp|lp|plc|gmbh|bv|nv|sarl|ag|pty|pte)\b/g;

function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,''`"]/g, "")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is the model reporting us as our own counterparty?
 *
 * An invoice names two parties and the page alone cannot say which is the
 * reader. Told who we are, a model still anchors on whichever name is repeated
 * most — and on a contractor's invoice addressed to us, that is us.
 *
 * The answer is always wrong and the cost is not cosmetic. `vendor` is what
 * the 1099-NEC summary groups contract labour by, so a contractor's fees
 * attributed to us produce a
 * summary that lists the wrong payee and runs the reporting-threshold check
 * against the wrong person. This is cheap to detect and impossible to spot
 * downstream, so it is checked here rather than trusted.
 */
function looksLikeUs(vendor: string | undefined, entity: string): boolean {
  if (!vendor || !entity) return false;
  const v = nameKey(vendor);
  const e = nameKey(entity);
  if (!v || !e) return false;
  return v === e || (e.length >= 6 && (v.includes(e) || e.includes(v)));
}

/**
 * The re-ask, and it stands alone rather than following the first instruction.
 *
 * Appending a correction to the original question made no difference: the model
 * re-read a long brief in which this was one rule among ten and produced the
 * same answer. On its own the correction has nothing to compete with, and the
 * question it asks is deliberately narrow — one visual fact about the page,
 * rather than the whole extraction restated.
 */
function correctionFor(entity: string, wrong: string): string {
  return [
    `Read this document again. Your previous answer named "${wrong}" as the vendor, and that is`,
    `${entity} — the business whose tax return is being prepared. That is us. We are never our`,
    "own vendor, so that answer is wrong and needs correcting.",
    "",
    "Answer one question from the page before anything else: whose name and address are printed",
    "at the very top, above the addressee block? That party issued this document.",
    "",
    `On this page ${entity} appears in the "invoice to" or "bill to" block, which means somebody`,
    "billed us. The vendor is the party at the top of the page, and `direction` is \"expense\".",
    "Ignore how often each name appears; position on the page decides this, not frequency.",
    "",
    "Now record the whole document again, with every other field exactly as you read it before.",
    `If the page truly names no party other than ${entity}, leave \`vendor\` out entirely — an`,
    "empty field is a question a reviewer answers in a glance, and our own name in it is a wrong",
    "answer that reaches a 1099 summary as the payee.",
  ].join("\n");
}

/**
 * The model's answer as an `Extraction` row.
 *
 * The one place this discards something the model said is the money fields on a
 * page it reported unreadable. A total attached to a page nobody could read is
 * by construction a guess, and it would be summed into a category total and put
 * on a Schedule C line with no mark on it. The raw answer is kept on the row, so
 * the figure is not lost — it is simply not treated as read.
 */
function normalise(
  docId: string,
  answer: Record<string, unknown>,
  raw: string,
  entity: string,
): Extraction {
  const status = oneOf(
    answer.status,
    ["extracted", "unreadable", "out-of-scope", "failed"] as const,
    "unreadable",
  );
  const readable = status === "extracted";

  const row: Extraction = {
    docId,
    status,
    statusDetail: text(answer.statusDetail),
    docType: oneOf(answer.docType, DOC_KINDS, "unknown"),
    direction: oneOf(answer.direction, ["expense", "income", "unknown"] as const, "unknown"),
    vendor: text(answer.vendor),
    vendorTaxId: text(answer.vendorTaxId),
    vendorAddress: text(answer.vendorAddress),
    invoiceNumber: text(answer.invoiceNumber),
    issueDate: isoDate(answer.issueDate),
    dueDate: isoDate(answer.dueDate),
    periodStart: isoDate(answer.periodStart),
    periodEnd: isoDate(answer.periodEnd),
    currency: currencyCode(answer.currency),
    subtotal: readable ? amount(answer.subtotal) : undefined,
    tax: readable ? amount(answer.tax) : undefined,
    taxRate: readable ? amount(answer.taxRate) : undefined,
    total: readable ? amount(answer.total) : undefined,
    lineItems: readable ? lineItemsOf(answer.lineItems) : [],
    paymentMethod: text(answer.paymentMethod),
    paymentLast4: text(answer.paymentLast4),
    confidence: fraction(answer.confidence),
    notes: text(answer.notes),
    modelId: MODEL,
    extractedAt: new Date().toISOString(),
    raw,
  };

  if (!readable && !row.statusDetail) {
    // Never leave a reviewer with a bare status. They open the flag list to
    // find out what to do about a filename, and a status word alone answers
    // nothing — least of all which of the two non-answers this is.
    row.statusDetail =
      status === "out-of-scope"
        ? "The model judged this not to be a financial document but did not say what it appears " +
          "to be. Open it before accepting that."
        : "The model reported the page as unreadable and gave no description of what it could see.";
  }
  if (looksLikeUs(row.vendor, entity)) {
    // The re-ask did not take. Drop it rather than store it: a missing vendor
    // is a question a reviewer can answer from the page in one glance, and a
    // wrong one is silent — if the document is contract labour it puts our own
    // name on the 1099 summary as the payee.
    row.notes = [
      row.notes,
      `The counterparty was read as "${row.vendor}", which is this entity. A document cannot ` +
        "name us as our own supplier, so the field was cleared rather than recorded. Read the " +
        "vendor off the head of the page and set it by hand.",
    ]
      .filter(Boolean)
      .join(" ");
    row.vendor = undefined;
    row.vendorTaxId = undefined;
    row.vendorAddress = undefined;
    // The direction was decided by the same misreading, so it is not evidence
    // either. "unknown" routes the document to a person; a confident wrong
    // direction flips the sign on a form line.
    row.direction = "unknown";
    row.confidence = Math.min(row.confidence, 0.5);
  }

  if (!readable && amount(answer.total) !== undefined) {
    row.notes = [
      row.notes,
      `A total of ${amount(answer.total)} was offered alongside an ${status} reading and has ` +
        "been set aside rather than counted. It is preserved in the raw answer on this row.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return row;
}

/** A row recording that the reading did not happen, and why. */
function failureRow(docId: string, detail: string): Extraction {
  return {
    docId,
    status: "failed",
    statusDetail: detail,
    docType: "unknown",
    direction: "unknown",
    lineItems: [],
    confidence: 0,
    modelId: MODEL,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Write the row, replacing any earlier one for the same document.
 *
 * Returns the previous row so the caller can say in the audit trail what figure
 * it replaced. An overwrite nobody recorded is how a total changes between two
 * readings of the same package with no trace of which was which.
 */
async function saveExtraction(row: Extraction): Promise<Extraction | undefined> {
  return mutate<Extraction[], Extraction | undefined>("extractions", [], (rows) => {
    const previous = rows.find((current) => current.docId === row.docId);
    return {
      next: previous
        ? rows.map((current) => (current.docId === row.docId ? row : current))
        : [...rows, row],
      result: previous,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Running one document
 * ────────────────────────────────────────────────────────────────────────── */

/** How a figure reads in an audit line when there was not one. */
function figure(row: Extraction | undefined, currency: string): string {
  if (!row || typeof row.total !== "number") return "no total";
  return money(row.total, row.currency ?? currency);
}

/**
 * Read one document.
 *
 * Throws only for faults that are not facts about the document: an id that is
 * not on the register, a missing API key, an authentication or rate-limit
 * refusal. Those must not be written as `failed` rows — a missing key would put
 * every filename in the corpus on the exception list and blame the documents
 * for a deployment problem.
 *
 * Everything that genuinely is about this document — a file missing from disk,
 * a type the model cannot open, a page count over the API ceiling, an answer
 * that came back empty — is stored as a `failed` row with a reason, so the
 * document stays visible and the exception engine can raise it.
 */
export async function extractDocument(docId: string, actor: string): Promise<Extraction> {
  const doc = await getDocument(docId);
  if (!doc) throw new Error(`No document ${docId} on the register.`);

  if (!modelConfigured()) {
    throw new Error(
      "The assistant's API key is not set, so no document can be read. Copy .env.example to " +
        ".env.local and fill in ANTHROPIC_API_KEY.",
    );
  }

  const period = (await getPeriod(doc.periodId)) ?? (await activePeriod());

  /** Store the row, log it, and hand it back — the single exit for every outcome. */
  const finish = async (row: Extraction) => {
    const previous = await saveExtraction(row);
    const replaced = previous
      ? ` Replaced an earlier ${previous.status} reading of ${figure(previous, period.currency)} ` +
        `from ${previous.extractedAt}.`
      : "";

    await record({
      actor,
      action: `extract.${row.status}`,
      subject: doc.id,
      result: row.status === "extracted" ? "ok" : row.status === "unreadable" ? "info" : "error",
      detail:
        `${doc.filename}: ${row.status}` +
        (row.status === "extracted"
          ? `, ${row.vendor ?? "vendor not read"}, ${figure(row, period.currency)}` +
            `, dated ${row.issueDate ?? "no date read"}, reading confidence ` +
            `${row.confidence.toFixed(2)}.`
          : `. ${row.statusDetail ?? "No detail given."}`) +
        replaced,
      periodId: doc.periodId,
      docId: doc.id,
    });
    return row;
  };

  const mediaType = MEDIA_TYPES[doc.mimeType];
  if (!mediaType) {
    return finish(
      failureRow(
        doc.id,
        `${doc.filename} is ${doc.mimeType}, which the model cannot be given as a page. Only ` +
          "PDF, PNG and JPEG can be read. Convert it and upload it again.",
      ),
    );
  }
  if (doc.bytes > PDF_LIMITS.maxBytes) {
    return finish(
      failureRow(
        doc.id,
        `${doc.filename} is ${(doc.bytes / (1024 * 1024)).toFixed(1)} MB, over the ` +
          `${PDF_LIMITS.maxBytes / (1024 * 1024)} MB the request can carry. Split it or ` +
          "re-export it smaller. It has not been read.",
      ),
    );
  }
  if (doc.pageCount !== undefined && doc.pageCount > PDF_LIMITS.maxPages) {
    return finish(
      failureRow(
        doc.id,
        `${doc.filename} has ${doc.pageCount} pages, over the ${PDF_LIMITS.maxPages}-page ` +
          "limit for one request. Split it into separate documents. It has not been read.",
      ),
    );
  }

  let data: string;
  try {
    data = (await readDocumentBytes(doc.id)).toString("base64");
  } catch (error) {
    return finish(
      failureRow(
        doc.id,
        `${doc.filename} is on the register but its file could not be read: ` +
          `${error instanceof Error ? error.message : "unknown error"}. This is a storage ` +
          "fault, not a fault of the document.",
      ),
    );
  }

  try {
    let answer = await extractFromDocument<Record<string, unknown>>({
      system: EXTRACTION_SYSTEM,
      instruction: instructionFor(doc, period),
      file: { data, mediaType, filename: doc.filename },
      tool: EXTRACTION_TOOL,
      maxTokens: TOKEN_BUDGET.extractionTokens,
    });

    // One corrective re-ask when the model names us as the counterparty. It is
    // a known-wrong answer with a known cause, and naming the specific error
    // back to the model is far more reliable than making the first instruction
    // longer — a rule that has to survive an entire prompt competes with every
    // other rule in it, while a correction arrives with nothing else in the way.
    const firstVendor = text(answer.value?.vendor);
    if (looksLikeUs(firstVendor, period.entity)) {
      const retry = await extractFromDocument<Record<string, unknown>>({
        system: EXTRACTION_SYSTEM,
        instruction: correctionFor(period.entity, firstVendor ?? ""),
        file: { data, mediaType, filename: doc.filename },
        tool: EXTRACTION_TOOL,
        maxTokens: TOKEN_BUDGET.extractionTokens,
      });
      if (retry.value) answer = retry;
    }

    if (!answer.value) {
      // `tool_choice` forces the tool, so an absent call means the response was
      // cut off or refused. Say which, because a truncated answer is fixed by a
      // bigger budget and a refusal is not.
      return finish(
        failureRow(
          doc.id,
          `The model returned no structured answer for ${doc.filename} (stop reason: ` +
            `${answer.stopReason ?? "none reported"}).` +
            (answer.stopReason === "max_tokens"
              ? " The answer was cut off before the tool call completed; the document is " +
                "probably longer than one extraction budget."
              : "") +
            ` What came back instead: ${answer.raw.slice(0, 400) || "nothing"}`,
        ),
      );
    }

    return finish(normalise(doc.id, answer.value, answer.raw, period.entity));
  } catch (error) {
    const explained = explainModelError(error);
    // 401 and 429 are the provider refusing the whole run, not a verdict on
    // this page. Rethrow so the batch stops and the console says so, rather
    // than writing thirty failed rows that read as thirty bad documents.
    if (explained.status === 401 || explained.status === 429) {
      await record({
        actor,
        action: "extract.aborted",
        subject: doc.id,
        result: "error",
        detail: `Extraction of ${doc.filename} was refused by the provider: ${explained.message}`,
        periodId: doc.periodId,
        docId: doc.id,
      });
      throw new Error(explained.message);
    }
    return finish(
      failureRow(doc.id, `The model call for ${doc.filename} failed: ${explained.message}`),
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Running a period
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Read everything in the period that has not been read.
 *
 * Pending means: no row at all, or a row that says `failed`. A failure is
 * retried because its usual causes — a transient provider error, a file that
 * had not finished being written — go away, and the row keeps the document on
 * the flag list in the meantime. An `unreadable` row is *not* retried: the
 * model has looked at the page and answered, and asking again spends a call to
 * receive the same answer. Re-reading one is a deliberate act, one document at
 * a time, through `extractDocument`.
 *
 * Sequential, not parallel. The corpus is tens of documents and the provider's
 * rate limit is shared with the classifier and the chat panel; a burst that
 * trips a 429 halfway through leaves a half-read period, which is the state
 * this whole app is built to avoid producing.
 */
export async function extractPending(
  periodId: string,
  actor: string,
  limit?: number,
): Promise<{
  run: number;
  extracted: number;
  unreadable: number;
  failed: number;
  results: Extraction[];
}> {
  const [docs, existing] = await Promise.all([
    listDocuments({ periodId }),
    readStore<Extraction[]>("extractions", []),
  ]);
  const byDoc = new Map(existing.map((row) => [row.docId, row]));

  const queue = docs.filter((doc) => {
    const row = byDoc.get(doc.id);
    return !row || row.status === "failed";
  });
  const selected = typeof limit === "number" && limit >= 0 ? queue.slice(0, limit) : queue;

  const results: Extraction[] = [];
  let extracted = 0;
  let unreadable = 0;
  let failed = 0;

  for (const doc of selected) {
    const row = await extractDocument(doc.id, actor);
    results.push(row);
    if (row.status === "extracted") extracted += 1;
    else if (row.status === "unreadable") unreadable += 1;
    else failed += 1;
  }

  await record({
    actor,
    action: "extract.run",
    subject: periodId,
    result: failed > 0 ? "error" : "ok",
    detail:
      `Read ${selected.length} of ${queue.length} document(s) awaiting extraction ` +
      `(${docs.length} in the period): ${extracted} extracted, ${unreadable} unreadable, ` +
      `${failed} failed. ${queue.length - selected.length} still pending. Documents already ` +
      "read, including ones previously reported unreadable, were left alone.",
    periodId,
  });

  return { run: selected.length, extracted, unreadable, failed, results };
}
