import "server-only";
import { record } from "./audit";
import { categoryName, deductibleFraction, getCategory } from "./categories";
import { listClassifications } from "./classify";
import { listDocuments } from "./documents";
import { listExtractions } from "./extract";
import { getPeriod, getSettings, inPeriod, maskTaxId, money } from "./settings";
import { mutate, newId, readStore } from "./store";
import { effectiveCategoryId } from "./types";
import type {
  Classification,
  ExceptionKind,
  ExceptionSeverity,
  Extraction,
  FilingPeriod,
  Settings,
  SourceDocument,
  TaxException,
} from "./types";

/**
 * The exception engine — the part of this product that is actually the product.
 *
 * Everything upstream collects and reads; everything downstream totals and
 * formats. This module is where the app says "a person has to look at this",
 * and it is the only thing standing between a stack of PDFs and a form that
 * looks finished. Three properties matter more than the rules themselves.
 *
 * **Detection is idempotent.** `detect` recomputes the whole finding set and
 * matches it against what is already on file by `kind` + documents
 * entries. A finding that is still true keeps its id, its status, and — the
 * important one — the note whoever closed it wrote. A re-run that reopened
 * everything a reviewer had worked through would make re-running detection
 * something people avoid, and stale findings are exactly what re-running is for.
 *
 * **A finding that no longer applies is dropped, and the drop is logged.** A
 * flag nobody can clear is worse than no flag: it teaches reviewers that the
 * list contains noise, and the next real finding is skimmed past with the rest.
 * The audit row is what stops "it disappeared" from being unanswerable.
 *
 * **Every finding names figures and filenames.** "Check this document" is a
 * to-do a reviewer has to reconstruct from scratch, and they will leave it. A
 * detail that says which two numbers disagree and by how much can be settled in
 * the time it takes to read it.
 *
 * Nothing here edits an `Extraction` or a `Classification`.
 * Flag, never fix.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Severity
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One table, so the console, the package and the form drafts all grade a
 * finding the same way.
 *
 * `high` means the figure on a form is wrong or unsupported if this is not
 * settled. `medium` means a judgement is missing. `low` means a piece of
 * paperwork is missing but no figure moves. Severity is a property of the
 * *kind*, not of the amount: a $40 duplicate and a $4,000 one are both a total
 * counted twice, and letting the amount set the grade would quietly hide the
 * small ones.
 */
const SEVERITY: Record<ExceptionKind, ExceptionSeverity> = {
  "duplicate-document": "high",
  "total-mismatch": "high",
  "unreadable-document": "high",
  "missing-period": "medium",
  "currency-mismatch": "low",
  "low-confidence-category": "medium",
  "category-needs-judgement": "medium",
  "missing-vendor-tax-id": "low",
  "possible-personal-expense": "medium",
  "capitalisation-threshold": "medium",
  "contractor-1099-threshold": "medium",
};

export function severityOf(kind: ExceptionKind): ExceptionSeverity {
  // An unknown kind grades high rather than low. A finding this table has not
  // been taught about is one nobody has thought through, and the safe default
  // for something nobody has thought through is the top of the list.
  return SEVERITY[kind] ?? "high";
}

const ALL_KINDS = Object.keys(SEVERITY) as ExceptionKind[];

/**
 * Categories where a purchase at or above the capitalisation threshold is a
 * capitalise-or-expense question rather than a straight deduction.
 *
 * `asset` categories qualify by their kind. The two named here qualify by their
 * own description: a repair large enough to be an improvement is capitalised,
 * and "supplies" at three thousand dollars is equipment that was filed under
 * the wrong word. Software subscriptions are deliberately absent — a large
 * annual hosting bill is not a durable good, and flagging every one of them
 * would fill the list with items nobody can action.
 */
const DURABLE_CATEGORIES = new Set(["expense-repairs", "expense-supplies"]);

const CONTRACT_LABOUR = "expense-contract-labor";
const PERSONAL = "non-deductible-personal";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Filename first, id second. A reviewer searches by the name on the file. */
function label(doc: SourceDocument): string {
  return `${doc.filename} (${doc.id})`;
}

function isDate(value?: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test((value ?? "").trim());
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A trading name reduced to something two spellings of it can agree on.
 *
 * Grouping on the raw string puts "Acme Design, Inc." and "ACME Design Inc"
 * in different buckets, and a contractor two dollars either side of the 1099
 * threshold ends up on neither side of it.
 */
function vendorKey(name?: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !["inc", "llc", "ltd", "limited", "co", "corp", "the"].includes(token))
    .join(" ")
    .trim();
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function monthAdd(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const total = year * 12 + (index - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return `${MONTH_NAMES[index - 1] ?? month} ${year}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The finding set
 * ────────────────────────────────────────────────────────────────────────── */

/** A finding before it is either matched to an existing row or raised as new. */
type Finding = {
  kind: ExceptionKind;
  title: string;
  detail: string;
  suggestedAction: string;
  docIds: string[];
  amount?: number;
  currency?: string;
};

type Raise = (finding: Finding) => void;

/**
 * What makes two findings the same finding across runs.
 *
 * Not the wording and not the amount — both change as an extraction improves,
 * and a reviewer's note must survive a re-extraction that shifts a figure by a
 * cent. The identity of a finding is what it is about: its kind and the records
 * it points at.
 */
function keyOf(finding: { kind: ExceptionKind; docIds: string[] }): string {
  return `${finding.kind}|${[...finding.docIds].sort().join(",")}`;
}

type Ctx = {
  period: FilingPeriod;
  settings: Settings;
  /** Documents in the period, in collection order. */
  docs: SourceDocument[];
  /** Every document on the register, so a duplicate across periods is seen. */
  allDocs: SourceDocument[];
  extractionByDoc: Map<string, Extraction>;
  classificationByDoc: Map<string, Classification>;
};

function currencyOf(ctx: Ctx, extraction?: Extraction): string {
  return (extraction?.currency ?? ctx.period.currency).toUpperCase();
}

function categoryOf(ctx: Ctx, docId: string): string | undefined {
  const classification = ctx.classificationByDoc.get(docId);
  return classification ? effectiveCategoryId(classification) : undefined;
}

/** Who chose the category in force, for a detail line that has to attribute it. */
function chosenBy(classification: Classification): string {
  return classification.overriddenCategoryId
    ? `${classification.overriddenBy ?? "a reviewer"} set this category by hand`
    : `the classifier chose it at ${pct(classification.confidence)} confidence`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rules — one function per kind, in the order they read best in the audit
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The same document twice, by bytes or by contents.
 *
 * Two different tests, one kind, and the detail must never conflate them. A
 * byte-identical pair is a file saved twice; a matching vendor, invoice number
 * and total across *different* bytes is the same invoice arriving down two
 * routes — the emailed PDF and the one downloaded from a portal. The second is
 * the one that slips past a hash check and lands on a form line twice.
 */
function duplicateDocuments(ctx: Ctx, raise: Raise): void {
  const inPeriodIds = new Set(ctx.docs.map((doc) => doc.id));

  const byHash = new Map<string, SourceDocument[]>();
  for (const doc of ctx.allDocs) {
    byHash.set(doc.sha256, [...(byHash.get(doc.sha256) ?? []), doc]);
  }

  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    if (!group.some((doc) => inPeriodIds.has(doc.id))) continue;

    const totals = group
      .map((doc) => ctx.extractionByDoc.get(doc.id)?.total)
      .filter((total): total is number => typeof total === "number");
    const currency = currencyOf(ctx, ctx.extractionByDoc.get(group[0].id));
    const elsewhere = group.filter((doc) => doc.periodId !== ctx.period.id);

    raise({
      kind: "duplicate-document",
      title: `Same file ingested ${group.length} times`,
      detail:
        `${group.map(label).join(", ")} are byte-identical (sha256 ${hash.slice(0, 12)}). ` +
        (totals.length > 0
          ? `The total read from them is ${money(totals[0], currency)}, so it reaches the category ` +
            `totals ${group.length} times. `
          : "Nothing has been read from them yet. ") +
        (elsewhere.length > 0
          ? `${elsewhere.map(label).join(", ")} sits under period ${elsewhere[0].periodId}, so the ` +
            `same document may be claimed in two periods.`
          : `All ${group.length} are in ${ctx.period.label}.`),
      suggestedAction:
        `Keep one copy and delete the others from the Documents tab with a reason, or resolve ` +
        `this with a note recording why more than one belongs here. Until then the amount is ` +
        `counted once per copy in every category total and on every form line it feeds.`,
      docIds: group.map((doc) => doc.id),
      amount: totals[0],
      currency: totals.length > 0 ? currency : undefined,
    });
  }

  const byContent = new Map<string, SourceDocument[]>();
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    const vendor = vendorKey(extraction.vendor);
    const invoice = (extraction.invoiceNumber ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!vendor || !invoice || typeof extraction.total !== "number") continue;
    const key = `${vendor}|${invoice}|${extraction.total.toFixed(2)}`;
    byContent.set(key, [...(byContent.get(key) ?? []), doc]);
  }

  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    const first = ctx.extractionByDoc.get(group[0].id);
    const currency = currencyOf(ctx, first);
    raise({
      kind: "duplicate-document",
      title: `${first?.vendor ?? "One vendor"} invoice ${first?.invoiceNumber} is on file ${group.length} times`,
      detail:
        `${group.map(label).join(" and ")} are different files, but each reads as vendor ` +
        `${first?.vendor}, invoice number ${first?.invoiceNumber} and a total of ` +
        `${money(first?.total ?? 0, currency)} ` +
        `(dated ${group.map((doc) => ctx.extractionByDoc.get(doc.id)?.issueDate ?? "no date").join(", ")}). ` +
        `Their bytes differ, so this is not a copied file — it is the same invoice collected twice, ` +
        `which a hash check cannot see.`,
      suggestedAction:
        `Compare the two files, keep the better copy, and delete the other with a reason. If they ` +
        `are genuinely two invoices that happen to share a number, resolve this with a note saying ` +
        `so — otherwise ${money(first?.total ?? 0, currency)} lands on the return twice.`,
      docIds: group.map((doc) => doc.id),
      amount: first?.total,
      currency,
    });
  }
}

/** The document does not add up against itself. */
function totalMismatch(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    const { subtotal, tax, total } = extraction;
    if (typeof subtotal !== "number" || typeof tax !== "number" || typeof total !== "number") continue;

    const sum = round(subtotal + tax);
    const delta = round(Math.abs(sum - total));
    if (delta <= 0.02) continue;

    const currency = currencyOf(ctx, extraction);
    raise({
      kind: "total-mismatch",
      title: `${extraction.vendor ?? doc.filename} does not add up`,
      detail:
        `On ${label(doc)}, subtotal ${money(subtotal, currency)} plus tax ${money(tax, currency)} ` +
        `comes to ${money(sum, currency)}, but the total read off the document is ` +
        `${money(total, currency)} — a difference of ${money(delta, currency)}. ` +
        `Category totals and every form line use the stated total of ${money(total, currency)}.`,
      suggestedAction:
        `Open the document and check which figures it actually prints. If a line was misread, ` +
        `re-run extraction for this document; if the document itself is inconsistent, ask ` +
        `${extraction.vendor ?? "the vendor"} for a corrected copy before the package goes out.`,
      docIds: [doc.id],
      amount: delta,
      currency,
    });
  }
}

/** The page is there and nobody can read it. */
function unreadableDocument(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status === "extracted") continue;

    raise({
      kind: "unreadable-document",
      title: `${doc.filename} came back ${extraction.status}`,
      detail:
        `${label(doc)} (${Math.max(1, Math.round(doc.bytes / 1024))} KB` +
        `${doc.pageCount ? `, ${doc.pageCount} page(s)` : ""}, from ${doc.source}` +
        `${doc.sourceDetail ? ` — ${doc.sourceDetail}` : ""}) came back ${extraction.status}: ` +
        `"${extraction.statusDetail ?? "no reason was recorded"}". Nothing has been read from it, ` +
        `so none of its money reaches a category total or a form line, and no figure on the draft ` +
        `reflects it.`,
      suggestedAction:
        `Re-scan or re-photograph it straight-on and upload the new copy, or key the figures in ` +
        `from the paper original. If the document is not needed for ${ctx.period.label}, delete it ` +
        `with a reason so the corpus does not carry a page nobody can read.`,
      docIds: [doc.id],
    });
  }
}

/**
 * A vendor that bills every month, with a month missing.
 *
 * Only gaps *between* documents count — a vendor billing in January and March
 * with nothing in February. A missing trailing month is left alone: a
 * subscription cancelled in February looks identical to one whose March invoice
 * has not been collected, and flagging every vendor's last month would put a
 * finding on nearly every recurring supplier in the quarter. Filling the list
 * with items that are usually nothing is how a list stops being read.
 */
function missingPeriodDocuments(ctx: Ctx, raise: Raise): void {
  const byVendor = new Map<string, { doc: SourceDocument; extraction: Extraction }[]>();
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    if (!isDate(extraction.issueDate) || !inPeriod(extraction.issueDate, ctx.period)) continue;
    const key = vendorKey(extraction.vendor);
    if (!key) continue;
    byVendor.set(key, [...(byVendor.get(key) ?? []), { doc, extraction }]);
  }

  for (const group of byVendor.values()) {
    if (group.length < 2) continue;
    const months = [...new Set(group.map((row) => monthKey(row.extraction.issueDate!)))].sort();
    if (months.length < 2) continue;

    const missing: string[] = [];
    for (let i = 0; i < months.length - 1; i++) {
      let cursor = monthAdd(months[i], 1);
      while (cursor < months[i + 1]) {
        missing.push(cursor);
        cursor = monthAdd(cursor, 1);
      }
    }
    if (missing.length < Math.max(1, ctx.settings.recurrenceGapMonths)) continue;

    const vendor = group[0].extraction.vendor ?? "This vendor";
    const currency = currencyOf(ctx, group[0].extraction);
    const seen = group
      .map(
        (row) =>
          `${row.extraction.issueDate} ${
            typeof row.extraction.total === "number" ? money(row.extraction.total, currency) : "no total"
          }`,
      )
      .join(", ");

    raise({
      kind: "missing-period",
      title: `No ${missing.map(monthLabel).join(" or ")} document from ${vendor}`,
      detail:
        `${vendor} bills monthly — ${group.length} document(s) in ${ctx.period.label}: ${seen} — but ` +
        `nothing is on file for ${missing.map(monthLabel).join(" or ")}. A vendor who billed ` +
        `either side of a gap almost certainly billed inside it too, so the likeliest reading is ` +
        `that the invoice exists and was never collected.`,
      suggestedAction:
        `Search the mailbox and the Drive folder for ${vendor}'s ` +
        `${missing.map(monthLabel).join(" and ")} invoice and upload it, or resolve this with a ` +
        `note recording that the month was not billed. A missing month is a deduction nobody is ` +
        `claiming.`,
      docIds: group.map((row) => row.doc.id),
    });
  }
}

/**
 * A figure in a currency other than the one the totals are added up in.
 *
 * Low severity, and worded as a note rather than a fault: a business that
 * genuinely invoices in more than one currency is ordinary, and telling
 * somebody their real AED invoice is a problem because a default said USD
 * would be the app inventing a rule nobody set. What it IS, is a figure that
 * cannot be added to a different currency's total without a rate somebody
 * chose — so it is surfaced, with its own amount intact, and left for a
 * person to convert if they want it on a line.
 */
function currencyMismatch(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    const declared = (extraction.currency ?? "").trim().toUpperCase();
    if (!declared || declared === ctx.period.currency.toUpperCase()) continue;

    raise({
      kind: "currency-mismatch",
      title: `${label(doc)} is in ${declared}`,
      detail:
        `${label(doc)} from ${extraction.vendor ?? "an unnamed vendor"} is denominated in ` +
        `${declared}` +
        `${typeof extraction.total === "number" ? ` (total ${money(extraction.total, declared)})` : ""} ` +
        `while totals here are added up in ${ctx.period.currency}. The document is read, ` +
        `categorised and listed exactly like any other; what it cannot do is join a total in a ` +
        `different currency, because nothing in this app converts at a rate nobody chose.`,
      suggestedAction:
        `Nothing is wrong with the document. If you want its amount inside a ${ctx.period.currency} ` +
        `total, convert at the rate the books use and record the rate, its date and the converted ` +
        `figure in the note. Otherwise accept this — a second currency is a fact about the ` +
        `business, not a fault in the paperwork.`,
      docIds: [doc.id],
      amount: extraction.total,
      currency: declared,
    });
  }
}

/** The classifier was not sure, and said so. */
function lowConfidenceCategory(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const classification = ctx.classificationByDoc.get(doc.id);
    if (!classification) continue;
    // A human override settles the question the confidence was measuring.
    // Re-raising it afterwards asks a reviewer to second-guess themselves.
    if (classification.overriddenCategoryId) continue;
    if (classification.confidence >= ctx.settings.reviewConfidence) continue;

    const extraction = ctx.extractionByDoc.get(doc.id);
    const currency = currencyOf(ctx, extraction);
    const category = getCategory(classification.categoryId);
    const alternatives = classification.alternatives
      .map((alternative) => `${categoryName(alternative.categoryId)} at ${pct(alternative.confidence)}`)
      .join(", ");

    raise({
      kind: "low-confidence-category",
      title: `${categoryName(classification.categoryId)} at ${pct(classification.confidence)} for ${doc.filename}`,
      detail:
        `${label(doc)}${extraction?.vendor ? ` from ${extraction.vendor}` : ""}` +
        `${typeof extraction?.total === "number" ? `, ${money(extraction.total, currency)}` : ""} was put in ` +
        `${categoryName(classification.categoryId)} at ${pct(classification.confidence)}, below the ` +
        `${pct(ctx.settings.reviewConfidence)} review threshold. ` +
        (alternatives ? `It was weighed against ${alternatives}. ` : "") +
        `Its reason: "${classification.rationale}"`,
      suggestedAction:
        `Open the document and either confirm the category by resolving this with a note, or ` +
        `override it in the Categories tab with a note saying what the spend was. ` +
        `${typeof extraction?.total === "number" ? `${money(extraction.total, currency)} sits on ` : "The amount sits on "}` +
        `${category?.formLine ?? "a form line"} until someone does.`,
      docIds: [doc.id],
      amount: extraction?.total,
      currency: typeof extraction?.total === "number" ? currency : undefined,
    });
  }
}

/**
 * The category itself is the judgement call.
 *
 * Raised on the category in force whoever chose it, including after a human
 * override. The question these categories carry is not "is this the right
 * category" — it is "what fraction is business", "capitalise or expense",
 * "which form does this belong on" — and picking the category does not answer
 * it. The reviewer who overrode is usually the same person who then has to
 * decide the rest.
 */
function categoryNeedsJudgement(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const classification = ctx.classificationByDoc.get(doc.id);
    if (!classification) continue;
    const categoryId = effectiveCategoryId(classification);
    const category = getCategory(categoryId);
    if (!category?.alwaysReview) continue;

    const extraction = ctx.extractionByDoc.get(doc.id);
    const currency = currencyOf(ctx, extraction);
    const total = extraction?.total;
    const fraction = deductibleFraction(categoryId);

    const carries =
      typeof total !== "number"
        ? `No total has been read from it yet.`
        : fraction === 0
          ? `The draft keeps all ${money(total, currency)} off the expense lines (${category.formLine}).`
          : fraction === 1
            ? `The draft carries the whole ${money(total, currency)} to ${category.formLine}.`
            : `The draft carries ${money(round(total * fraction), currency)} of ${money(total, currency)} ` +
              `to ${category.formLine}.`;

    raise({
      kind: "category-needs-judgement",
      title: `${category.name} needs a person: ${doc.filename}`,
      detail:
        `${label(doc)}${extraction?.vendor ? ` from ${extraction.vendor}` : ""}` +
        `${extraction?.issueDate ? ` dated ${extraction.issueDate}` : ""} is categorised as ` +
        `${category.name}, and ${chosenBy(classification)}. That category always goes to a human: ` +
        `${category.reviewReason ?? "the call is not the assistant's to make."} ${carries}`,
      suggestedAction:
        `Make that call and record it in the note — the figure the reviewer decides on, and why. ` +
        `This app does not give tax advice and will not decide it for you.`,
      docIds: [doc.id],
      amount: total,
      currency: typeof total === "number" ? currency : undefined,
    });
  }
}

/** Contract labour with nobody's tax number on it. */
function missingVendorTaxId(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    if (categoryOf(ctx, doc.id) !== CONTRACT_LABOUR) continue;
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    if (extraction.vendorTaxId?.trim()) continue;

    const currency = currencyOf(ctx, extraction);
    raise({
      kind: "missing-vendor-tax-id",
      title: `No tax ID on ${extraction.vendor ?? doc.filename}`,
      detail:
        `${label(doc)} is contract labour to ${extraction.vendor ?? "an unnamed contractor"}` +
        `${typeof extraction.total === "number" ? ` for ${money(extraction.total, currency)}` : ""}` +
        `${extraction.issueDate ? ` dated ${extraction.issueDate}` : ""}, and no tax ID is printed ` +
        `on it. A 1099-NEC cannot be prepared without the contractor's TIN, and the deduction is ` +
        `unaffected either way — this is paperwork, not money.`,
      suggestedAction:
        `Ask ${extraction.vendor ?? "the contractor"} for a completed Form W-9 and pass it to the ` +
        `accountant. Resolve this with a note when it is on file, or note that they are a ` +
        `corporation and no 1099 is due.`,
      docIds: [doc.id],
      amount: extraction.total,
      currency: typeof extraction.total === "number" ? currency : undefined,
    });
  }
}

/** Something that looks like it was not for the business. */
function possiblePersonalExpense(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const classification = ctx.classificationByDoc.get(doc.id);
    if (!classification || effectiveCategoryId(classification) !== PERSONAL) continue;

    const extraction = ctx.extractionByDoc.get(doc.id);
    const currency = currencyOf(ctx, extraction);
    raise({
      kind: "possible-personal-expense",
      title: `Possibly personal: ${extraction?.vendor ?? doc.filename}`,
      detail:
        `${label(doc)}${extraction?.vendor ? ` from ${extraction.vendor}` : ""}` +
        `${extraction?.issueDate ? ` on ${extraction.issueDate}` : ""}` +
        `${typeof extraction?.total === "number" ? ` for ${money(extraction.total, currency)}` : ""} ` +
        `is categorised as personal spend, and ${chosenBy(classification)}. ` +
        `Calling a purchase personal removes a deduction, so it is stated as a possibility for a ` +
        `person to confirm and never applied as a conclusion.` +
        (classification.rationale ? ` The reason given: "${classification.rationale}"` : ""),
      suggestedAction:
        `Confirm whether this was for the business. If it was, override the category with a note ` +
        `saying what it was for; if it was not, accept this exception so the amount stays off the ` +
        `return with the reason on the record.`,
      docIds: [doc.id],
      amount: extraction?.total,
      currency: typeof extraction?.total === "number" ? currency : undefined,
    });
  }
}

/** Large enough that expensing it in full is a decision, not a default. */
function capitalisationThreshold(ctx: Ctx, raise: Raise): void {
  for (const doc of ctx.docs) {
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    if (typeof extraction.total !== "number") continue;
    if (Math.abs(extraction.total) < ctx.settings.capitalisationThreshold) continue;

    const categoryId = categoryOf(ctx, doc.id);
    const category = categoryId ? getCategory(categoryId) : undefined;
    if (!category) continue;
    if (category.kind !== "asset" && !DURABLE_CATEGORIES.has(category.id)) continue;

    const currency = currencyOf(ctx, extraction);
    raise({
      kind: "capitalisation-threshold",
      title: `${money(extraction.total, currency)} durable purchase: ${extraction.vendor ?? doc.filename}`,
      detail:
        `${label(doc)} — ${extraction.vendor ?? "an unnamed vendor"}` +
        `${extraction.issueDate ? `, ${extraction.issueDate}` : ""}` +
        `${extraction.lineItems[0]?.description ? `, "${extraction.lineItems[0].description}"` : ""} — ` +
        `totals ${money(extraction.total, currency)}, at or above the ` +
        `${money(ctx.settings.capitalisationThreshold, ctx.period.currency)} capitalisation ` +
        `threshold, and is categorised as ${category.name} (${category.formLine}).`,
      suggestedAction:
        `Decide with the tax manager whether to capitalise and depreciate it, expense it under the ` +
        `de minimis safe harbour, or elect section 179 — then record the decision and the figure ` +
        `in the note. The choice changes this year's deduction and the next several years' as well.`,
      docIds: [doc.id],
      amount: extraction.total,
      currency,
    });
  }
}

/** A contractor paid enough that a 1099-NEC is in play. */
function contractor1099Threshold(ctx: Ctx, raise: Raise): void {
  const byContractor = new Map<string, { doc: SourceDocument; extraction: Extraction }[]>();

  for (const doc of ctx.docs) {
    if (categoryOf(ctx, doc.id) !== CONTRACT_LABOUR) continue;
    const extraction = ctx.extractionByDoc.get(doc.id);
    if (!extraction || extraction.status !== "extracted") continue;
    if (typeof extraction.total !== "number") continue;
    // A foreign-currency document is not added in. It reaches the reviewer as
    // a currency-mismatch finding instead; adding EUR to USD to decide a
    // reporting threshold would be a wrong answer dressed as a precise one.
    if (currencyOf(ctx, extraction) !== ctx.period.currency.toUpperCase()) continue;
    const key = vendorKey(extraction.vendor);
    if (!key) continue;
    byContractor.set(key, [...(byContractor.get(key) ?? []), { doc, extraction }]);
  }

  for (const group of byContractor.values()) {
    const total = round(group.reduce((sum, row) => sum + Math.abs(row.extraction.total ?? 0), 0));
    if (total < ctx.settings.contractor1099Threshold) continue;

    const vendor = group[0].extraction.vendor ?? "This contractor";
    const currency = ctx.period.currency;
    const taxId = group.map((row) => row.extraction.vendorTaxId).find((value) => value?.trim());

    raise({
      kind: "contractor-1099-threshold",
      title: `${vendor} is over the 1099-NEC threshold at ${money(total, currency)}`,
      detail:
        `${vendor} has ${group.length} contract-labour document(s) in ${ctx.period.label} totalling ` +
        `${money(total, currency)}, at or above the ` +
        `${money(ctx.settings.contractor1099Threshold, currency)} reporting threshold ` +
        `(${group
          .map(
            (row) =>
              `${row.extraction.issueDate ?? "no date"} ${money(row.extraction.total ?? 0, currency)}`,
          )
          .join(", ")}). ` +
        (taxId
          ? `A tax ID is on file, ending ${maskTaxId(taxId)}. `
          : `No tax ID is recorded on any of them. `) +
        `The threshold is an annual one and this is a single quarter, so the year-to-date figure ` +
        `can only be higher than this.`,
      suggestedAction:
        `Confirm ${vendor} is on the 1099-NEC list for the year and that a completed W-9 is held` +
        `${taxId ? "" : ", starting with a request for the W-9"}. This app produces a summary of ` +
        `who crosses the threshold; it does not prepare or file a 1099.`,
      docIds: group.map((row) => row.doc.id),
      amount: total,
      currency,
    });
  }
}

/** Worst first, and open before closed — the order a reviewer works in. */
const SEVERITY_RANK: Record<ExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

export async function listExceptions(filter?: {
  periodId?: string;
  status?: TaxException["status"];
  kind?: ExceptionKind;
  docId?: string;
}): Promise<TaxException[]> {
  const all = await readStore<TaxException[]>("exceptions", []);
  return all
    .filter((exception) => {
      if (filter?.periodId && exception.periodId !== filter.periodId) return false;
      if (filter?.status && exception.status !== filter.status) return false;
      if (filter?.kind && exception.kind !== filter.kind) return false;
      if (filter?.docId && !exception.docIds.includes(filter.docId)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        Number(a.status !== "open") - Number(b.status !== "open") ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.raisedAt.localeCompare(b.raisedAt) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Recompute the period's findings.
 *
 * Safe to run as often as anyone likes, which is the point: it runs after an
 * extraction and after a categorisation, and each time it has to leave a
 * reviewer's work where they
 * left it. What survives a re-run is the id, the status, and the note. What is
 * refreshed is the wording, the figures and the severity — those are derived
 * from records that change, and a detail quoting last week's total is a detail
 * that gets a reviewer to the wrong conclusion.
 *
 * `byKind` carries a count for every kind, including the zeroes. A kind absent
 * from the record would read as "not checked", and every one of them was.
 */
export async function detect(
  periodId: string,
  actor: string,
): Promise<{ raised: number; carriedForward: number; byKind: Record<string, number> }> {
  const period = await getPeriod(periodId);
  if (!period) {
    // Returning an empty result would report a period with no findings, which
    // is the same shape as a clean quarter and reads as reassurance.
    throw new Error(
      `No filing period with id ${periodId}. Detection cannot run against a period that is not ` +
        `configured, and reporting no findings for one would read as a clean quarter.`,
    );
  }

  const [settings, allDocs, extractions, classifications] = await Promise.all([
    getSettings(),
    listDocuments(),
    listExtractions(periodId),
    listClassifications(periodId),
  ]);

  const ctx: Ctx = {
    period,
    settings,
    docs: allDocs.filter((doc) => doc.periodId === periodId),
    allDocs,
    extractionByDoc: new Map(extractions.map((row) => [row.docId, row])),
    classificationByDoc: new Map(classifications.map((row) => [row.docId, row])),
  };

  const findings: Finding[] = [];
  const seen = new Set<string>();
  const raise: Raise = (finding) => {
    const key = keyOf(finding);
    // Two rules can reach the same conclusion about the same records — the
    // hash duplicate and the content duplicate, most obviously. One finding
    // per key, first rule wins, so a reviewer never sees the same item twice.
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  duplicateDocuments(ctx, raise);
  unreadableDocument(ctx, raise);
  totalMismatch(ctx, raise);
  currencyMismatch(ctx, raise);
  missingPeriodDocuments(ctx, raise);
  lowConfidenceCategory(ctx, raise);
  categoryNeedsJudgement(ctx, raise);
  possiblePersonalExpense(ctx, raise);
  capitalisationThreshold(ctx, raise);
  contractor1099Threshold(ctx, raise);
  missingVendorTaxId(ctx, raise);

  const now = new Date().toISOString();

  const outcome = await mutate<
    TaxException[],
    {
      raised: number;
      carriedForward: number;
      dropped: TaxException[];
      restated: { exception: TaxException; wasClosed: boolean }[];
      kept: TaxException[];
    }
  >("exceptions", [], (all) => {
    const mine = all.filter((exception) => exception.periodId === periodId);
    const others = all.filter((exception) => exception.periodId !== periodId);
    const onFile = new Map(mine.map((exception) => [keyOf(exception), exception]));

    const kept: TaxException[] = [];
    const restated: { exception: TaxException; wasClosed: boolean }[] = [];
    let raisedCount = 0;
    let carriedForward = 0;

    for (const finding of findings) {
      const prior = onFile.get(keyOf(finding));
      const severity = severityOf(finding.kind);

      if (prior) {
        carriedForward++;
        if (prior.detail !== finding.detail) {
          restated.push({ exception: prior, wasClosed: prior.status !== "open" });
        }
        kept.push({
          ...prior,
          severity,
          title: finding.title,
          detail: finding.detail,
          suggestedAction: finding.suggestedAction,
          docIds: finding.docIds,
          amount: finding.amount,
          currency: finding.currency,
          // status, raisedAt, raisedBy, resolvedAt, resolvedBy and
          // resolutionNote are carried over untouched. They belong to whoever
          // worked the item, and detection does not get to overwrite them.
        });
        continue;
      }

      raisedCount++;
      kept.push({
        id: newId("exc"),
        periodId,
        kind: finding.kind,
        severity,
        title: finding.title,
        detail: finding.detail,
        suggestedAction: finding.suggestedAction,
        docIds: finding.docIds,
        amount: finding.amount,
        currency: finding.currency,
        status: "open",
        raisedAt: now,
        raisedBy: actor,
      });
    }

    const keptIds = new Set(kept.map((exception) => exception.id));
    const dropped = mine.filter((exception) => !keptIds.has(exception.id));

    return {
      next: [...others, ...kept],
      result: { raised: raisedCount, carriedForward, dropped, restated, kept },
    };
  });

  const byKind = Object.fromEntries(
    ALL_KINDS.map((kind) => [kind, outcome.kept.filter((exception) => exception.kind === kind).length]),
  ) as Record<string, number>;

  await record({
    actor,
    action: "exception.detect",
    subject: periodId,
    result: "ok",
    detail:
      `Detection over ${ctx.docs.length} document(s): ${outcome.raised} raised, ${outcome.carriedForward} carried ` +
      `forward with their status and notes intact, ${outcome.dropped.length} retired. ` +
      `${outcome.kept.filter((exception) => exception.status === "open").length} open. ` +
      `Kinds present: ${ALL_KINDS.filter((kind) => byKind[kind] > 0)
        .map((kind) => `${kind} ${byKind[kind]}`)
        .join(", ") || "none"}.`,
    periodId,
  });

  /**
   * One row per retired finding, not a count.
   *
   * A finding that vanishes with nothing but a total to explain it is
   * indistinguishable from one that was lost, and the reviewer who spent ten
   * minutes writing a resolution note has no way to show it ever existed. The
   * note is quoted here because this row is now the only place it survives.
   */
  for (const exception of outcome.dropped) {
    await record({
      actor,
      action: "exception.retired",
      subject: exception.id,
      result: "info",
      detail:
        `Retired ${exception.kind} "${exception.title}" (raised ${exception.raisedAt} by ` +
        `${exception.raisedBy}, status ${exception.status}) — the records behind it no longer ` +
        `meet the rule. Documents: ${exception.docIds.join(", ") || "none"}.` +
        (exception.resolutionNote
          ? ` Closed by ${exception.resolvedBy ?? "someone"} with the note: "${exception.resolutionNote}"`
          : ""),
      periodId,
      exceptionId: exception.id,
      docId: exception.docIds[0],
    });
  }

  /**
   * A closed item whose figures moved is worth a row of its own. Nobody is
   * asked to reopen it — that is a person's call — but the trail has to show
   * that what was resolved is not quite what is on file now.
   */
  for (const { exception, wasClosed } of outcome.restated) {
    if (!wasClosed) continue;
    await record({
      actor,
      action: "exception.restated",
      subject: exception.id,
      result: "info",
      detail:
        `${exception.kind} "${exception.title}" was ${exception.status} and its underlying figures ` +
        `have since changed. The resolution note stands; reopen it if the change matters. ` +
        `Previously: ${exception.detail}`,
      periodId,
      exceptionId: exception.id,
      docId: exception.docIds[0],
    });
  }

  return { raised: outcome.raised, carriedForward: outcome.carriedForward, byKind };
}

/**
 * Close one finding.
 *
 * The note is required and refused when blank, here rather than only at the
 * route, because this function is the last place that can insist. A closed item
 * with no note says somebody dealt with this and nothing about what they found;
 * six months on, at the point someone is asked to defend a figure, that is
 * indistinguishable from nobody having looked at all.
 *
 * `accept` is the difference between "this was wrong and is now fixed" and
 * "this is right as it stands and here is why". Both close the item; only one
 * of them claims anything changed.
 */
export async function resolveException(input: {
  id: string;
  actor: string;
  note: string;
  accept?: boolean;
}): Promise<TaxException> {
  const note = (input.note ?? "").trim();
  if (!note) {
    throw new Error(
      "Closing an exception needs a note saying what was found or decided. A closed item with no " +
        "note is indistinguishable from one nobody looked at.",
    );
  }

  const status: TaxException["status"] = input.accept ? "accepted" : "resolved";
  const now = new Date().toISOString();

  const outcome = await mutate<
    TaxException[],
    { prior?: TaxException; updated?: TaxException }
  >("exceptions", [], (all) => {
    const prior = all.find((exception) => exception.id === input.id);
    if (!prior) return { next: all, result: {} };

    const updated: TaxException = {
      ...prior,
      status,
      resolvedAt: now,
      resolvedBy: input.actor,
      resolutionNote: note,
    };
    return {
      next: all.map((exception) => (exception.id === input.id ? updated : exception)),
      result: { prior, updated },
    };
  });

  if (!outcome.updated || !outcome.prior) {
    throw new Error(`No exception with id ${input.id}.`);
  }

  await record({
    actor: input.actor,
    action: input.accept ? "exception.accept" : "exception.resolve",
    subject: outcome.updated.id,
    result: "ok",
    detail:
      `${input.accept ? "Accepted" : "Resolved"} ${outcome.prior.severity} ` +
      `${outcome.prior.kind} "${outcome.prior.title}"` +
      (outcome.prior.status !== "open" ? ` (it was already ${outcome.prior.status})` : "") +
      `. Documents: ${outcome.prior.docIds.join(", ") || "none"}. Note: ${note}`,
    periodId: outcome.updated.periodId,
    exceptionId: outcome.updated.id,
    docId: outcome.updated.docIds[0],
  });

  return outcome.updated;
}

/**
 * Put a closed finding back on the list.
 *
 * Also needs a note. Reopening overrides somebody's judgement, and the person
 * who wrote the resolution deserves to read why in the same trail their note is
 * in. The old note is cleared from the record so an open item never displays a
 * resolution — the audit row below is where it goes on surviving.
 */
export async function reopenException(
  id: string,
  actor: string,
  note: string,
): Promise<TaxException> {
  const reason = (note ?? "").trim();
  if (!reason) {
    throw new Error(
      "Reopening an exception needs a note saying why the earlier resolution no longer stands.",
    );
  }

  const outcome = await mutate<
    TaxException[],
    { prior?: TaxException; updated?: TaxException }
  >("exceptions", [], (all) => {
    const prior = all.find((exception) => exception.id === id);
    if (!prior) return { next: all, result: {} };

    const updated: TaxException = {
      ...prior,
      status: "open",
      resolvedAt: undefined,
      resolvedBy: undefined,
      resolutionNote: undefined,
    };
    return {
      next: all.map((exception) => (exception.id === id ? updated : exception)),
      result: { prior, updated },
    };
  });

  if (!outcome.updated || !outcome.prior) {
    throw new Error(`No exception with id ${id}.`);
  }

  await record({
    actor,
    action: "exception.reopen",
    subject: outcome.updated.id,
    result: "ok",
    detail:
      `Reopened ${outcome.prior.kind} "${outcome.prior.title}", previously ` +
      `${outcome.prior.status}` +
      (outcome.prior.resolvedBy ? ` by ${outcome.prior.resolvedBy}` : "") +
      (outcome.prior.resolutionNote
        ? ` with the note: "${outcome.prior.resolutionNote}"`
        : " with no note on file") +
      `. Reopened because: ${reason}`,
    periodId: outcome.updated.periodId,
    exceptionId: outcome.updated.id,
    docId: outcome.updated.docIds[0],
  });

  return outcome.updated;
}
