/**
 * The domain model, shared by the API routes, the UI, the fixture generator and
 * the agent's native tools. Deliberately small and serialisable: every record
 * round-trips through a JSON file in the workspace's Drive folder, so nothing
 * here may hold a class instance or a Date.
 *
 * Timestamps are ISO 8601 strings, always UTC. Money is a number in
 * `FilingPeriod.currency` minor-unit-free form (dollars, not cents) plus an
 * explicit currency code on anything that can arrive in a foreign one — a tax
 * package that silently adds EUR to USD is worse than one that refuses to add
 * them at all.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Filing period and entity
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The scope of one preparation run.
 *
 * Everything is scoped to a period. Data minimisation is a rule, not a
 * preference: a sweep that collects a vendor's whole history to file one
 * quarter has taken documents nobody asked for.
 */
export type FilingPeriod = {
  id: string;
  /** Human label, e.g. "2025 Q1". */
  label: string;
  /** Legal entity the filing is for. */
  entity: string;
  /** Inclusive start date, ISO `YYYY-MM-DD`. */
  start: string;
  /** Inclusive end date, ISO `YYYY-MM-DD`. */
  end: string;
  /** Which tax authority's forms the drafts map onto. */
  jurisdiction: string;
  /** Cash or accrual. Decides whether a document's date or its payment date rules. */
  basis: "cash" | "accrual";
  /** Reporting currency. Documents in anything else are flagged, never converted. */
  currency: string;
  status: "open" | "packaged" | "handed-off";
  handedOffAt?: string;
  handedOffTo?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Tax categories
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What a category *does* to the return, which is not the same as what it is
 * called. `kind` decides which side of the draft a total lands on, and
 * `deductiblePct` is the one field that quietly changes a number — meals at 50%
 * is the classic way a draft comes out wrong while every document is right.
 */
export type CategoryKind =
  /** Revenue. Adds to gross receipts. */
  | "income"
  /** Deductible business expense. Maps to a form line. */
  | "expense"
  /** Cost of goods sold. Separate from expenses on the form. */
  | "cogs"
  /** Capitalised — depreciated rather than expensed. Never a straight deduction. */
  | "asset"
  /** Real, recorded, and not deductible here. Personal, or belongs on another form. */
  | "non-deductible";

export type TaxCategory = {
  id: string;
  name: string;
  kind: CategoryKind;
  /** The form and line this rolls up to, e.g. "Schedule C, line 18". */
  formLine: string;
  /** Stable line key used by the form mapper. */
  lineKey: string;
  /** What belongs here, in the words a preparer would use. */
  description: string;
  /** Hints for the classifier. Not a rule engine — the model still decides. */
  keywords: string[];
  /**
   * Fraction of the amount that reaches the form, 0–1.
   *
   * Absent means 100%. Present means the draft must show both the recorded
   * amount and the amount that lands on the line, because a reviewer checking
   * a receipt against a form line needs to see why they differ.
   */
  deductiblePct?: number;
  /**
   * Anything landing here is flagged for a human regardless of the model's
   * confidence — the category itself is the judgement call.
   */
  alwaysReview?: boolean;
  /** Why it always needs review, shown on the flag. */
  reviewReason?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Documents
 * ────────────────────────────────────────────────────────────────────────── */

export type DocumentSource = "drive" | "gmail" | "upload" | "fixture";

/** A collected file, before anything has been read out of it. */
export type SourceDocument = {
  id: string;
  periodId: string;
  filename: string;
  source: DocumentSource;
  /** Drive file id, Gmail message id, or the local path a fixture came from. */
  sourceRef?: string;
  /** Who or what it arrived from — a sender address, a folder, an uploader. */
  sourceDetail?: string;
  mimeType: string;
  bytes: number;
  pageCount?: number;
  /**
   * SHA-256 of the file itself.
   *
   * Byte-identical duplicates are found here and nowhere else. The *other*
   * kind of duplicate — the same invoice saved twice with different bytes —
   * is a content finding, not a hash match, and the two must not be
   * conflated in the exception text.
   */
  sha256: string;
  ingestedAt: string;
  ingestedBy: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Extraction
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What the document is.
 *
 * Deliberately wider than "kinds of invoice". People hand a tax preparer
 * whatever carries the money — a bank statement, a platform's payout report, a
 * signed retainer — and a list that stops at invoices pushes all of it into
 * "other", where nothing downstream can tell a document that was placed from
 * one that was given up on. A named kind is one the classifier and the reviewer
 * can both reason about.
 */
export type DocumentKind =
  | "invoice-issued"
  | "invoice-received"
  | "receipt"
  | "credit-note"
  /** A vendor's or platform's account statement: what is owed across a period. */
  | "statement"
  /** A bank or card statement: movements on an account, not one purchase. */
  | "bank-statement"
  | "payout-report"
  | "mileage-log"
  /** An agreement stating fees, rates or a retainer. Financial, though not a bill. */
  | "contract"
  | "other"
  | "unknown";

export type LineItem = {
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
};

/**
 * What the model read off one document.
 *
 * `status: "unreadable"` is a first-class outcome, not an error. A scan with no
 * legible figures must land in the exceptions list with its filename, never be
 * dropped from the corpus so the counts look clean.
 *
 * `status: "out-of-scope"` is a different outcome again, and the two are kept
 * apart on purpose. Unreadable says there is financial content on the page and
 * nobody could make it out, so somebody should fetch a better copy.
 * Out-of-scope says the page was perfectly legible and is not a financial
 * record at all — a photograph, a CV, a screenshot of a conversation. Collapsed
 * into one status, a holiday photo is indistinguishable from a bad scan on the
 * flag list, and a reviewer spends an afternoon chasing better copies of
 * documents that were never going to be documents. They also lead opposite
 * ways: a bad scan is chased, an out-of-scope file is simply declined and told
 * to whoever uploaded it.
 */
export type Extraction = {
  docId: string;
  status: "extracted" | "unreadable" | "out-of-scope" | "failed";
  /**
   * Why, when status is not "extracted". Shown to the reviewer verbatim.
   *
   * On `out-of-scope` it carries what the document appears to be, because that
   * sentence is the whole of the answer the person who uploaded the file gets.
   */
  statusDetail?: string;

  docType: DocumentKind;
  /** "expense" = money out, "income" = money in. Decides the sign on the form. */
  direction: "expense" | "income" | "unknown";

  vendor?: string;
  vendorTaxId?: string;
  vendorAddress?: string;
  invoiceNumber?: string;

  /** ISO `YYYY-MM-DD`. The date printed on the document. */
  issueDate?: string;
  dueDate?: string;
  /** Service period, where the document states one. */
  periodStart?: string;
  periodEnd?: string;

  currency?: string;
  subtotal?: number;
  tax?: number;
  taxRate?: number;
  total?: number;

  lineItems: LineItem[];
  paymentMethod?: string;
  paymentLast4?: string;

  /** 0–1. The model's own reading confidence, not a category confidence. */
  confidence: number;
  /** Anything the model wants the reviewer to know. Never suppressed. */
  notes?: string;

  modelId: string;
  extractedAt: string;
  /** Verbatim model output, kept so a disputed figure can be traced. */
  raw?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Classification
 * ────────────────────────────────────────────────────────────────────────── */

export type Classification = {
  docId: string;
  categoryId: string;
  /** 0–1. Below `Settings.reviewConfidence` raises a flag. */
  confidence: number;
  /** Why this category, in one sentence, from the document's own contents. */
  rationale: string;
  /** Runners-up, so a reviewer can see what it was weighed against. */
  alternatives: { categoryId: string; confidence: number }[];
  needsReview: boolean;
  reviewReason?: string;
  classifiedAt: string;
  modelId: string;

  /** Set when a human corrected it. The model's answer is kept, not overwritten. */
  overriddenCategoryId?: string;
  overriddenBy?: string;
  overriddenAt?: string;
  overrideNote?: string;
};

/** The category actually in force: the human's if there is one, else the model's. */
export function effectiveCategoryId(c: Classification): string {
  return c.overriddenCategoryId ?? c.categoryId;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Exceptions — the flag list
 * ────────────────────────────────────────────────────────────────────────── */

export type ExceptionKind =
  | "duplicate-document"
  | "total-mismatch"
  | "unreadable-document"
  | "missing-period"
  | "currency-mismatch"
  | "low-confidence-category"
  | "category-needs-judgement"
  | "missing-vendor-tax-id"
  | "possible-personal-expense"
  | "capitalisation-threshold"
  | "contractor-1099-threshold";

export type ExceptionSeverity = "high" | "medium" | "low";

/**
 * Something a human has to look at.
 *
 * The whole product hangs off this record. Every one carries a specific reason
 * and a suggested action — "check this" with no reason is a to-do the reviewer
 * has to reconstruct, and they will skip it.
 */
export type TaxException = {
  id: string;
  periodId: string;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  /** The specifics: amounts, dates, filenames. Never a generic sentence. */
  detail: string;
  /** What would close it, addressed to the reviewer. */
  suggestedAction: string;
  docIds: string[];
  /** The money at stake, where there is a single figure. */
  amount?: number;
  currency?: string;
  status: "open" | "resolved" | "accepted";
  raisedAt: string;
  raisedBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Required to close one. A resolution with no note is not a resolution. */
  resolutionNote?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Draft forms
 * ────────────────────────────────────────────────────────────────────────── */

export type FormLine = {
  /** The line number as the form prints it, e.g. "18". */
  line: string;
  label: string;
  /** What the documents add up to, before any deductibility haircut. */
  recorded: number;
  /** What lands on the line. Differs from `recorded` where deductiblePct < 1. */
  amount: number;
  currency: string;
  categoryIds: string[];
  docCount: number;
  /** Set where `amount !== recorded`, saying why in words. */
  adjustmentNote?: string;
  /** Open exceptions touching this line. A line with these is not final. */
  openExceptionIds: string[];
};

export type FormDraft = {
  id: string;
  periodId: string;
  /** "schedule-c" | "1099-nec-summary" | "1040-es-worksheet". */
  formId: string;
  formName: string;
  /**
   * There is exactly one value. A form produced here is a draft and stays one;
   * nothing in this codebase can set it to anything else.
   */
  status: "draft";
  lines: FormLine[];
  totals: { label: string; amount: number; currency: string }[];
  /** Exceptions still open when this was drafted, by id. */
  openExceptionIds: string[];
  /** Categories in the period that no line on this form accounts for. */
  unmappedCategoryIds: string[];
  generatedAt: string;
  generatedBy: string;
  modelId?: string;
  /** Printed on every rendering of the draft. */
  disclaimer: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Review package
 * ────────────────────────────────────────────────────────────────────────── */

export type PackageDocumentRow = {
  docId: string;
  filename: string;
  vendor?: string;
  issueDate?: string;
  amount?: number;
  currency?: string;
  categoryId?: string;
  categoryName?: string;
  confidence?: number;
  flags: string[];
};

/** What the tax manager receives. Assembled, never filed. */
export type ReviewPackage = {
  id: string;
  periodId: string;
  createdAt: string;
  createdBy: string;
  counts: {
    documents: number;
    extracted: number;
    unreadable: number;
    classified: number;
    needsReview: number;
    openExceptions: number;
  };
  categoryTotals: {
    categoryId: string;
    name: string;
    kind: CategoryKind;
    recorded: number;
    deductible: number;
    docCount: number;
  }[];
  documentIndex: PackageDocumentRow[];
  formDraftIds: string[];
  openExceptionIds: string[];
  /** One paragraph the reviewer reads first. Drafted, and marked as drafted. */
  summary?: string;
  /** Markdown rendering of the whole package, for the handoff email/file. */
  markdown?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Audit
 * ────────────────────────────────────────────────────────────────────────── */

/** Append-only. Never edited, never deleted — that is what makes it a trail. */
export type AuditEvent = {
  id: string;
  at: string;
  /** The human or system that caused it. "agent" is never a reviewer. */
  actor: string;
  action: string;
  /** What it happened to: a doc id, an exception id, a period id. */
  subject: string;
  result: "ok" | "error" | "info";
  detail: string;
  periodId?: string;
  docId?: string;
  exceptionId?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Settings
 * ────────────────────────────────────────────────────────────────────────── */

export type Settings = {
  /** Legal entity the workspace prepares for. */
  entity: string;
  /** Employer identification number, masked everywhere it is displayed. */
  entityTaxId?: string;
  jurisdiction: string;
  currency: string;
  basis: "cash" | "accrual";
  /** Period the console is working on. */
  activePeriodId: string;
  periods: FilingPeriod[];
  /** Who this app acts as. Every audit entry is attributed to this address. */
  preparerEmail: string;
  /** Who the finished package goes to. Never the preparer. */
  taxManagerEmail: string;
  /** Classifications below this confidence are flagged. 0–1. */
  reviewConfidence: number;
  /** Spend at or above this on a durable item is a capitalisation question. */
  capitalisationThreshold: number;
  /** Contractor payments at or above this in the year need a 1099-NEC. */
  contractor1099Threshold: number;
  /** A recurring vendor missing this many consecutive periods raises a gap flag. */
  recurrenceGapMonths: number;
  /** Tone for drafted summaries and request emails. */
  voice: string;
  /** Where collected documents live once the Drive connector is wired in. */
  driveFolderId?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Cross-cutting view models
 * ────────────────────────────────────────────────────────────────────────── */

/** One document with everything known about it, as the UI and agent see it. */
export type DocumentView = {
  doc: SourceDocument;
  extraction?: Extraction;
  classification?: Classification;
  exceptions: TaxException[];
};

/** What the status endpoint answers with. Nulls mean "not computed yet". */
export type PrepStatus = {
  period: FilingPeriod;
  modelConfigured: boolean;
  counts: {
    documents: number;
    extracted: number;
    unreadable: number;
    pendingExtraction: number;
    classified: number;
    pendingClassification: number;
    needsReview: number;
  };
  exceptions: { open: number; high: number; medium: number; low: number };
  money: {
    currency: string;
    grossReceipts: number | null;
    totalExpenses: number | null;
    deductibleExpenses: number | null;
    unclassified: number | null;
  };
  forms: { formId: string; formName: string; generatedAt: string }[];
  latestPackageId?: string;
  /** Sources swept and what each returned. Absent connector is not zero results. */
  sources: { source: DocumentSource; available: boolean; documents: number; detail?: string }[];
};
