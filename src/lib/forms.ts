import "server-only";
import { record } from "./audit";
import { CATEGORIES, categoryName, deductibleFraction, getCategory } from "./categories";
import { categoryTotals, listClassifications } from "./classify";
import { listExceptions } from "./exceptions";
import { listExtractions } from "./extract";
import { getPeriod, getSettings, money } from "./settings";
import { mutate, readStore } from "./store";
import { effectiveCategoryId } from "./types";
import type { FilingPeriod, FormDraft, FormLine, Settings, TaxException } from "./types";

/**
 * The draft forms.
 *
 * There is no model call in this file, and there must never be one. Every
 * figure here is arithmetic over the category totals, and the reason is narrow:
 * a total a model computed is a total nobody can check. A reviewer holding a
 * receipt can follow a sum back through `categoryTotals` to the documents that
 * made it; they cannot follow a sentence a model produced back to anything.
 * The model's work finished at extraction and categorisation, both of which a
 * person can audit document by document. Addition is not the part that needs
 * intelligence.
 *
 * Three things this module does that a naive roll-up would not:
 *
 *   Meals reach line 24b at 50%, and the line carries both figures. A draft
 *   that puts the receipt total on the line is wrong while every document
 *   behind it is right, which is the hardest kind of error to catch in review.
 *   `recorded` and `amount` are separate fields for exactly this, and
 *   `adjustmentNote` says in words why they differ.
 *
 *   Depreciation and the home office carry nothing to their lines. Both are
 *   computed on another form from facts no receipt states — Form 4562 for the
 *   first, Form 8829 and an exclusive-use square footage for the second. The
 *   recorded total is shown so the money is not lost; the line stays at zero so
 *   nobody signs a number this app invented.
 *
 *   `unmappedCategoryIds` names the money that reached no line at all. A form
 *   that silently drops the uncategorised pile balances perfectly and is
 *   missing whatever was in it.
 *
 * `status` has one value, `"draft"`, and no code path in this file or any other
 * sets it to anything else. That is the product invariant, enforced by the type
 * rather than by a check that someone could forget to write.
 */

/** Printed on every rendering of every draft. Verbatim, and not parameterised. */
const DISCLAIMER =
  "DRAFT — prepared by DO-09 from the documents listed. Figures are as extracted, " +
  "not as advised. Nothing here has been filed, and no line is final until a tax " +
  "professional has reviewed it against the open items.";

export const FORMS: { id: string; name: string; blurb: string }[] = [
  {
    id: "schedule-c",
    name: "Schedule C (Form 1040) — Profit or Loss From Business",
    blurb:
      "Income and expense lines rolled up from the categorised documents. Every figure is " +
      "arithmetic over those documents, and every line that was adjusted says so.",
  },
  {
    id: "1099-nec-summary",
    name: "1099-NEC summary — contract labour by counterparty",
    blurb:
      "Who was paid for contract labour in this period, who crosses the annual reporting " +
      "threshold, and who has no tax ID on file. A worksheet for whoever files the 1099s. " +
      "It is not a 1099 and it has not been filed.",
  },
  {
    id: "1040-es-worksheet",
    name: "1040-ES worksheet — estimated tax",
    blurb:
      "Self-employment tax worked from the Schedule C draft's net profit. The income-tax " +
      "line is left blank on purpose: it depends on facts this app does not hold.",
  },
];

const FORM_IDS = new Set(FORMS.map((form) => form.id));

/** Statutory rates for the estimated-tax worksheet. Named, not inlined. */
const SE_BASIS_RATE = 0.9235;
const SE_TAX_RATE = 0.153;

/* ────────────────────────────────────────────────────────────────────────────
 * The Schedule C line map
 *
 * Lines are keyed by `TaxCategory.lineKey`, not by category id, so a category
 * added to `categories.ts` with an existing `lineKey` lands on the right line
 * without anyone editing this file. A category added with a *new* lineKey lands
 * nowhere, shows up in `unmappedCategoryIds`, and says so on the draft — which
 * is the failure mode to want. The alternative, a default line, quietly absorbs
 * money nobody mapped.
 * ────────────────────────────────────────────────────────────────────────── */

type LineSpec = { line: string; label: string; lineKeys: string[]; note?: string };

const SC_GROSS_RECEIPTS: LineSpec = {
  line: "1",
  label: "Gross receipts or sales",
  lineKeys: ["sc-1"],
};

const SC_RETURNS: LineSpec = {
  line: "2",
  label: "Returns and allowances",
  lineKeys: ["sc-2"],
  note:
    "Credit notes and refunds are recorded as positive figures here and subtracted on line 3. " +
    "Read as a deduction from receipts, not as an expense.",
};

const SC_COGS: LineSpec = {
  line: "4",
  label: "Cost of goods sold (from line 42)",
  lineKeys: ["sc-36", "sc-38"],
};

const SC_OTHER_INCOME: LineSpec = {
  line: "6",
  label: "Other income",
  lineKeys: ["sc-6"],
};

const SC_EXPENSES: LineSpec[] = [
  { line: "8", label: "Advertising", lineKeys: ["sc-8"] },
  { line: "9", label: "Car and truck expenses", lineKeys: ["sc-9"] },
  { line: "10", label: "Commissions and fees", lineKeys: ["sc-10"] },
  { line: "11", label: "Contract labor", lineKeys: ["sc-11"] },
  { line: "13", label: "Depreciation and section 179 expense", lineKeys: ["sc-13"] },
  { line: "15", label: "Insurance (other than health)", lineKeys: ["sc-15"] },
  { line: "16b", label: "Interest — other", lineKeys: ["sc-16b"] },
  { line: "17", label: "Legal and professional services", lineKeys: ["sc-17"] },
  { line: "18", label: "Office expense", lineKeys: ["sc-18"] },
  { line: "20a", label: "Rent or lease — vehicles, machinery, equipment", lineKeys: ["sc-20a"] },
  { line: "20b", label: "Rent or lease — other business property", lineKeys: ["sc-20b"] },
  { line: "21", label: "Repairs and maintenance", lineKeys: ["sc-21"] },
  { line: "22", label: "Supplies", lineKeys: ["sc-22"] },
  { line: "23", label: "Taxes and licenses", lineKeys: ["sc-23"] },
  { line: "24a", label: "Travel", lineKeys: ["sc-24a"] },
  { line: "24b", label: "Deductible meals", lineKeys: ["sc-24b"] },
  { line: "25", label: "Utilities", lineKeys: ["sc-25"] },
  { line: "26", label: "Wages", lineKeys: ["sc-26"] },
  { line: "27a", label: "Other expenses", lineKeys: ["sc-27a"] },
];

const SC_HOME_OFFICE: LineSpec = {
  line: "30",
  label: "Expenses for business use of your home",
  lineKeys: ["sc-30"],
};

/** Every lineKey Schedule C accounts for. Anything else is unmapped money. */
const SCHEDULE_C_LINE_KEYS = new Set(
  [SC_GROSS_RECEIPTS, SC_RETURNS, SC_COGS, SC_OTHER_INCOME, ...SC_EXPENSES, SC_HOME_OFFICE].flatMap(
    (spec) => spec.lineKeys,
  ),
);

/* ────────────────────────────────────────────────────────────────────────────
 * Reading and writing drafts
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Draft ids are derived from the period and the form, not generated.
 *
 * A regenerated Schedule C replaces the row it supersedes rather than adding a
 * second one, and a `ReviewPackage` that recorded `formDraftIds` last week
 * still points at the current draft. A random id per run would leave a package
 * referring to figures nobody can see any more, which is the same as referring
 * to nothing.
 */
function draftId(periodId: string, formId: string): string {
  return `frm_${periodId}_${formId}`;
}

export async function listForms(periodId: string): Promise<FormDraft[]> {
  const rows = await readStore<FormDraft[]>("forms", []);
  const order = new Map(FORMS.map((form, index) => [form.id, index]));
  return rows
    .filter((draft) => draft.periodId === periodId)
    .sort((a, b) => (order.get(a.formId) ?? 99) - (order.get(b.formId) ?? 99));
}

export async function getForm(periodId: string, formId: string): Promise<FormDraft | undefined> {
  const rows = await readStore<FormDraft[]>("forms", []);
  return rows.find((draft) => draft.periodId === periodId && draft.formId === formId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The figures behind a draft
 * ────────────────────────────────────────────────────────────────────────── */

type CategoryTotal = {
  categoryId: string;
  name: string;
  kind: string;
  recorded: number;
  deductible: number;
  docCount: number;
};

type Context = {
  period: FilingPeriod;
  settings: Settings;
  currency: string;
  /** Recorded totals per category id. Absent means no money in it, not zero-ish. */
  totals: Map<string, CategoryTotal>;
  /** Open exception ids touching documents in a given category. */
  exceptionsByCategory: Map<string, Set<string>>;
  /** Every exception open in the period when the draft was cut. */
  open: TaxException[];
  openExceptionIds: string[];
  /** Open exception ids per document, for the 1099 summary's per-vendor rows. */
  exceptionsByDoc: Map<string, Set<string>>;
  generatedAt: string;
  generatedBy: string;
};

async function buildContext(periodId: string, actor: string): Promise<Context> {
  const period = await getPeriod(periodId);
  if (!period) {
    // A draft against a period that is not configured would show every line at
    // zero, which is the shape of a quarter with no business rather than of a
    // misconfiguration. Refuse instead of producing a clean-looking blank form.
    throw new Error(
      `No filing period with id ${periodId}. A form cannot be drafted against a period that ` +
        `does not exist — every line would read zero, which looks like a quiet quarter.`,
    );
  }

  const [settings, totals, classifications, open] = await Promise.all([
    getSettings(),
    categoryTotals(periodId),
    listClassifications(periodId),
    listExceptions({ periodId, status: "open" }),
  ]);

  const categoryByDoc = new Map(
    classifications.map((c) => [c.docId, effectiveCategoryId(c)] as const),
  );

  const exceptionsByCategory = new Map<string, Set<string>>();
  const exceptionsByDoc = new Map<string, Set<string>>();
  for (const exception of open) {
    for (const docId of exception.docIds) {
      const forDoc = exceptionsByDoc.get(docId) ?? new Set<string>();
      forDoc.add(exception.id);
      exceptionsByDoc.set(docId, forDoc);

      const categoryId = categoryByDoc.get(docId);
      if (!categoryId) continue;
      const forCategory = exceptionsByCategory.get(categoryId) ?? new Set<string>();
      forCategory.add(exception.id);
      exceptionsByCategory.set(categoryId, forCategory);
    }
  }

  return {
    period,
    settings,
    currency: period.currency,
    totals: new Map(totals.map((row) => [row.categoryId, row as CategoryTotal])),
    exceptionsByCategory,
    exceptionsByDoc,
    open,
    openExceptionIds: open.map((exception) => exception.id),
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
  };
}

/** Two decimal places, applied at every step so float noise never reaches a line. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The fraction of a recorded amount that reaches a Schedule C line.
 *
 * `deductibleFraction` from the chart handles meals at 50% and zeroes assets
 * and non-deductibles. The one override is the home office: the chart calls it
 * a full-fraction expense because the *category* is deductible, but the
 * allowable figure is computed on Form 8829 from an exclusive-use square
 * footage that no receipt states. Carrying the household bills straight to
 * line 30 would put a number on the return that nothing in this app can
 * justify, so the line stays at zero and says why.
 */
function lineFraction(categoryId: string): number {
  if (categoryId === "expense-home-office") return 0;
  return deductibleFraction(categoryId);
}

/** Category ids feeding a set of lineKeys, in chart order. */
function categoriesFor(lineKeys: string[]): string[] {
  return CATEGORIES.filter((category) => lineKeys.includes(category.lineKey)).map((c) => c.id);
}

/**
 * Why a category's recorded amount and its amount on the line differ.
 *
 * One sentence per category, naming both figures. "Adjusted" with no figures is
 * a note a reviewer has to reconstruct from the chart, and they will not.
 */
function haircutSentence(
  categoryId: string,
  recorded: number,
  docCount: number,
  currency: string,
): string | undefined {
  const fraction = lineFraction(categoryId);
  if (Math.abs(fraction - 1) < 1e-9) return undefined;
  if (Math.abs(recorded) < 0.005) return undefined;

  const name = categoryName(categoryId);
  const docs = `${docCount} ${docCount === 1 ? "document" : "documents"}`;
  const recordedText = money(recorded, currency);

  if (categoryId === "expense-home-office") {
    return (
      `${name}: ${recordedText} recorded across ${docs} carries nothing to this line. The ` +
      `allowable claim is computed on Form 8829 from an exclusive-use square footage that no ` +
      `document here states, and this app does not compute it.`
    );
  }

  const category = getCategory(categoryId);
  if (category?.kind === "asset") {
    return (
      `${name}: ${recordedText} across ${docs} is capitalised, not expensed, so nothing reaches ` +
      `this line. The deductible figure comes from Form 4562 or a section 179 election, both of ` +
      `which are a person's decision.`
    );
  }

  if (fraction === 0) {
    return `${name}: ${recordedText} across ${docs} is recorded and does not reach this line.`;
  }

  const pct = Math.round(fraction * 100);
  return (
    `${name} reaches the line at ${pct} per cent: ${recordedText} recorded across ${docs}, ` +
    `${money(round2(recorded * fraction), currency)} on the line. The difference is the ` +
    `statutory limit, not a discrepancy in the receipts.`
  );
}

/** A line summed from the categories mapped to it. */
function categoryLine(spec: LineSpec, ctx: Context): FormLine {
  const categoryIds = categoriesFor(spec.lineKeys);
  const notes: string[] = [];
  const exceptions = new Set<string>();

  let recorded = 0;
  let amount = 0;
  let docCount = 0;

  for (const categoryId of categoryIds) {
    const total = ctx.totals.get(categoryId);
    if (!total) continue;
    recorded += total.recorded;
    amount += total.recorded * lineFraction(categoryId);
    docCount += total.docCount;

    const sentence = haircutSentence(categoryId, total.recorded, total.docCount, ctx.currency);
    if (sentence) notes.push(sentence);
    for (const id of ctx.exceptionsByCategory.get(categoryId) ?? []) exceptions.add(id);
  }

  if (spec.note) notes.unshift(spec.note);

  return {
    line: spec.line,
    label: spec.label,
    recorded: round2(recorded),
    amount: round2(amount),
    currency: ctx.currency,
    categoryIds,
    docCount,
    /**
     * An explicit note is attached whether or not the arithmetic changed the
     * figure. `adjustmentNote` exists to stop a reader misreading a line, and
     * line 2 — recorded positive, subtracted on line 3 — is misread without one
     * even though nothing was adjusted.
     */
    ...(notes.length ? { adjustmentNote: notes.join(" ") } : {}),
    openExceptionIds: [...exceptions],
  };
}

/**
 * A subtotal computed from lines above it.
 *
 * It inherits their categories, document counts and open exceptions, which is
 * the point: net profit is not final while anything feeding it is open, and the
 * line carries the ids that say so rather than leaving a reader to join them up.
 */
function computedLine(
  line: string,
  label: string,
  parts: { line: FormLine; sign: 1 | -1 }[],
  ctx: Context,
  note?: string,
): FormLine {
  const categoryIds = new Set<string>();
  const exceptions = new Set<string>();
  let recorded = 0;
  let amount = 0;
  let docCount = 0;

  for (const part of parts) {
    recorded += part.sign * part.line.recorded;
    amount += part.sign * part.line.amount;
    docCount += part.line.docCount;
    for (const id of part.line.categoryIds) categoryIds.add(id);
    for (const id of part.line.openExceptionIds) exceptions.add(id);
  }

  const notes: string[] = [];
  if (note) notes.push(note);
  if (Math.abs(round2(recorded) - round2(amount)) >= 0.005) {
    notes.push(
      `Recorded is what the documents behind this line add up to; the line is after the ` +
        `deductibility adjustments above. The ${money(
          round2(Math.abs(recorded - amount)),
          ctx.currency,
        )} difference is explained on the lines that carry it, not lost.`,
    );
  }

  return {
    line,
    label,
    recorded: round2(recorded),
    amount: round2(amount),
    currency: ctx.currency,
    categoryIds: [...categoryIds],
    docCount,
    ...(notes.length ? { adjustmentNote: notes.join(" ") } : {}),
    openExceptionIds: [...exceptions],
  };
}

/** Categories holding money that no line on Schedule C accounts for. */
function unmappedForScheduleC(ctx: Context): string[] {
  return [...ctx.totals.values()]
    .filter((total) => Math.abs(total.recorded) >= 0.005)
    .filter((total) => {
      const category = getCategory(total.categoryId);
      return !category || !SCHEDULE_C_LINE_KEYS.has(category.lineKey);
    })
    .map((total) => total.categoryId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Schedule C
 * ────────────────────────────────────────────────────────────────────────── */

function buildScheduleC(ctx: Context): FormDraft {
  const line1 = categoryLine(SC_GROSS_RECEIPTS, ctx);
  const line2 = categoryLine(SC_RETURNS, ctx);
  const line3 = computedLine(
    "3",
    "Subtract line 2 from line 1",
    [
      { line: line1, sign: 1 },
      { line: line2, sign: -1 },
    ],
    ctx,
  );
  const line4 = categoryLine(SC_COGS, ctx);
  const line5 = computedLine(
    "5",
    "Gross profit — subtract line 4 from line 3",
    [
      { line: line3, sign: 1 },
      { line: line4, sign: -1 },
    ],
    ctx,
  );
  const line6 = categoryLine(SC_OTHER_INCOME, ctx);
  const line7 = computedLine(
    "7",
    "Gross income — add lines 5 and 6",
    [
      { line: line5, sign: 1 },
      { line: line6, sign: 1 },
    ],
    ctx,
  );

  const expenses = SC_EXPENSES.map((spec) => categoryLine(spec, ctx));
  const line28 = computedLine(
    "28",
    "Total expenses before business use of home — add lines 8 through 27a",
    expenses.map((line) => ({ line, sign: 1 as const })),
    ctx,
  );
  const line29 = computedLine(
    "29",
    "Tentative profit or loss — subtract line 28 from line 7",
    [
      { line: line7, sign: 1 },
      { line: line28, sign: -1 },
    ],
    ctx,
  );
  const line30 = categoryLine(SC_HOME_OFFICE, ctx);
  const line31 = computedLine(
    "31",
    "Net profit or loss — subtract line 30 from line 29",
    [
      { line: line29, sign: 1 },
      { line: line30, sign: -1 },
    ],
    ctx,
    "Not a figure to rely on while anything on the open-items list is unresolved.",
  );

  const lines = [line1, line2, line3, line4, line5, line6, line7, ...expenses, line28, line29, line30, line31];
  const unmapped = unmappedForScheduleC(ctx);
  const offForm = unmapped.reduce(
    (sum, categoryId) => sum + (ctx.totals.get(categoryId)?.recorded ?? 0),
    0,
  );

  return {
    id: draftId(ctx.period.id, "schedule-c"),
    periodId: ctx.period.id,
    formId: "schedule-c",
    formName: formName("schedule-c"),
    status: "draft",
    lines,
    totals: [
      { label: "Gross income (line 7)", amount: line7.amount, currency: ctx.currency },
      { label: "Total expenses (line 28)", amount: line28.amount, currency: ctx.currency },
      { label: "Net profit or loss (line 31)", amount: line31.amount, currency: ctx.currency },
      {
        label: "Recorded but on no line of this form",
        amount: round2(offForm),
        currency: ctx.currency,
      },
    ],
    openExceptionIds: ctx.openExceptionIds,
    unmappedCategoryIds: unmapped,
    generatedAt: ctx.generatedAt,
    generatedBy: ctx.generatedBy,
    disclaimer: DISCLAIMER,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1099-NEC summary
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Contract labour, one row per counterparty.
 *
 * This is a worksheet for whoever files the 1099s. It is not a 1099, it is not
 * a filing, and the form name says so on every rendering.
 *
 * Two things it must not smooth over. The threshold is *annual* and this period
 * is a quarter, so a vendor below it here can still cross it by December — the
 * row says that rather than reading as "no 1099 needed". And a document with no
 * vendor on it is its own row, never folded into a neighbouring name: guessing
 * which contractor an unnamed invoice belongs to is how a payment lands on the
 * wrong person's 1099.
 */
async function buildContractorSummary(ctx: Context): Promise<FormDraft> {
  const [extractions, classifications] = await Promise.all([
    listExtractions(ctx.period.id),
    listClassifications(ctx.period.id),
  ]);

  const contractDocIds = new Set(
    classifications
      .filter((c) => effectiveCategoryId(c) === "expense-contract-labor")
      .map((c) => c.docId),
  );

  type Row = {
    key: string;
    vendor: string;
    total: number;
    docCount: number;
    taxId?: string;
    docIds: string[];
  };
  const rows = new Map<string, Row>();
  let foreignCurrency = 0;
  let missingTotal = 0;

  for (const extraction of extractions) {
    if (!contractDocIds.has(extraction.docId)) continue;

    /**
     * Same two exclusions `categoryTotals` applies, for the same reason: a
     * document in another currency is an exception, not a conversion, and a
     * document with no total is a gap, not a zero. Both are counted and
     * reported under the table rather than dropped.
     */
    if (extraction.currency && extraction.currency !== ctx.currency) {
      foreignCurrency += 1;
      continue;
    }
    if (typeof extraction.total !== "number" || !Number.isFinite(extraction.total)) {
      missingTotal += 1;
      continue;
    }

    const vendor = extraction.vendor?.trim();
    const key = vendor ? vendor.toLowerCase().replace(/\s+/g, " ") : " no-vendor";
    const existing = rows.get(key);
    const row: Row = existing ?? {
      key,
      vendor: vendor ?? "Vendor not stated on the document",
      total: 0,
      docCount: 0,
      docIds: [],
    };
    row.total += extraction.total;
    row.docCount += 1;
    row.docIds.push(extraction.docId);
    if (!row.taxId && extraction.vendorTaxId?.trim()) row.taxId = extraction.vendorTaxId.trim();
    rows.set(key, row);
  }

  const threshold = ctx.settings.contractor1099Threshold;
  const thresholdText = money(threshold, ctx.currency);
  const ordered = [...rows.values()].sort((a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor));

  const lines: FormLine[] = ordered.map((row, index) => {
    const recorded = round2(row.total);
    const crosses = recorded >= threshold;
    /**
     * `amount` is what would be reported on a 1099-NEC on these figures, which
     * is nothing for a vendor under the threshold. Keeping `recorded` beside it
     * is what stops the row reading as "this contractor was not paid".
     */
    const amount = crosses ? recorded : 0;
    const notes: string[] = [];

    if (!crosses) {
      notes.push(
        `${money(recorded, ctx.currency)} in ${ctx.period.label} is below the ${thresholdText} ` +
          `reporting threshold, so nothing is carried. The threshold is annual and this is one ` +
          `period — payments later in the year can cross it, and this row is not a decision that ` +
          `no 1099 is due.`,
      );
    }
    if (row.key === " no-vendor") {
      notes.push(
        "No vendor name was read off these documents. They are listed separately rather than " +
          "added to another contractor's row, because a payment attributed to the wrong person " +
          "is a wrong 1099.",
      );
    }

    const exceptions = new Set<string>();
    for (const docId of row.docIds) {
      for (const id of ctx.exceptionsByDoc.get(docId) ?? []) exceptions.add(id);
    }

    return {
      line: String(index + 1),
      /**
       * The tax-ID fact lives in the label rather than in `adjustmentNote`,
       * because it is true of the vendor whether or not the amount was adjusted
       * and a reviewer chasing W-9s needs it on the row they are reading.
       */
      label: row.taxId ? `${row.vendor} — tax ID on file` : `${row.vendor} — no tax ID on file`,
      recorded,
      amount,
      currency: ctx.currency,
      categoryIds: ["expense-contract-labor"],
      docCount: row.docCount,
      ...(notes.length ? { adjustmentNote: notes.join(" ") } : {}),
      openExceptionIds: [...exceptions],
    };
  });

  const recordedTotal = round2(lines.reduce((sum, line) => sum + line.recorded, 0));
  const reportable = round2(lines.reduce((sum, line) => sum + line.amount, 0));

  /**
   * Documents excluded from every row above get a row of their own with a zero
   * on it, rather than no mention at all. A contract-labour invoice in euros
   * and a contract-labour invoice with no readable total are both real payments
   * this worksheet cannot size; leaving them out entirely makes the totals look
   * complete, which is the only way this table can mislead.
   */
  const setAside: string[] = [];
  if (foreignCurrency) {
    setAside.push(
      `${foreignCurrency} ${foreignCurrency === 1 ? "document is" : "documents are"} in a currency ` +
        `other than ${ctx.currency} and ${foreignCurrency === 1 ? "is" : "are"} not included. This ` +
        `app flags a foreign currency, it does not convert one.`,
    );
  }
  if (missingTotal) {
    setAside.push(
      `${missingTotal} ${missingTotal === 1 ? "document has" : "documents have"} no readable total ` +
        `and ${missingTotal === 1 ? "is" : "are"} not included. A missing figure is not a payment ` +
        `of nothing.`,
    );
  }
  if (setAside.length) {
    lines.push({
      line: "—",
      label: "Contract-labour documents set aside, not counted in any row above",
      recorded: 0,
      amount: 0,
      currency: ctx.currency,
      categoryIds: ["expense-contract-labor"],
      docCount: foreignCurrency + missingTotal,
      adjustmentNote: `${setAside.join(" ")} Each is on the open-items list with its filename.`,
      openExceptionIds: [],
    });
  }

  const scoped = new Set<string>();
  for (const line of lines) for (const id of line.openExceptionIds) scoped.add(id);
  /**
   * Exceptions about the 1099 questions themselves belong on this form even
   * when the document behind one is categorised elsewhere — a missing W-9 is
   * this worksheet's problem wherever it was found.
   */
  for (const exception of ctx.open) {
    if (
      exception.kind === "contractor-1099-threshold" ||
      exception.kind === "missing-vendor-tax-id"
    ) {
      scoped.add(exception.id);
    }
  }

  return {
    id: draftId(ctx.period.id, "1099-nec-summary"),
    periodId: ctx.period.id,
    formId: "1099-nec-summary",
    formName: formName("1099-nec-summary"),
    status: "draft",
    lines: lines.length
      ? lines
      : [
          {
            line: "1",
            label: "No contract-labour documents categorised in this period",
            recorded: 0,
            amount: 0,
            currency: ctx.currency,
            categoryIds: ["expense-contract-labor"],
            docCount: 0,
            adjustmentNote:
              "Nothing was categorised as contract labour. That is a statement about what was " +
              "collected and read, not a statement that no contractors were paid.",
            openExceptionIds: [],
          },
        ],
    totals: [
      { label: "Contract labour recorded in the period", amount: recordedTotal, currency: ctx.currency },
      {
        label: `At or above the ${thresholdText} threshold`,
        amount: reportable,
        currency: ctx.currency,
      },
      {
        label: "Below the threshold on this period alone",
        amount: round2(recordedTotal - reportable),
        currency: ctx.currency,
      },
    ],
    openExceptionIds: [...scoped],
    /**
     * Empty on purpose. This worksheet only ever accounts for contract labour,
     * so listing every other category as "unmapped" would turn a real Schedule C
     * signal into noise on a form where it means nothing. The Schedule C draft
     * is where unmapped money is reported.
     */
    unmappedCategoryIds: [],
    generatedAt: ctx.generatedAt,
    generatedBy: ctx.generatedBy,
    disclaimer: DISCLAIMER,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1040-ES worksheet
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Estimated tax, as far as it can honestly be taken.
 *
 * Self-employment tax is arithmetic on net profit and is computed. Income tax
 * is not: it depends on filing status, a spouse's income, other household
 * income, deductions, credits and payments already made, none of which this app
 * holds. So line 5 is left blank rather than set to zero. A zero on a tax
 * worksheet reads as "nothing due", and a reviewer skimming a worksheet that
 * already got the hard-looking self-employment figure right has every reason to
 * believe it.
 *
 * There is no grand total for the same reason. A total computed with a blank in
 * it is not a total.
 */
function buildEstimatedTax(ctx: Context, scheduleC: FormDraft): FormDraft {
  const netProfit = scheduleC.lines.find((line) => line.line === "31")?.amount ?? 0;
  const profitable = netProfit > 0;
  const seBasis = profitable ? round2(netProfit * SE_BASIS_RATE) : 0;
  const seTax = round2(seBasis * SE_TAX_RATE);
  const halfSeTax = round2(seTax / 2);

  const openCount = scheduleC.openExceptionIds.length;

  const lines: FormLine[] = [
    {
      line: "1",
      label: "Net profit from the Schedule C draft (line 31)",
      recorded: netProfit,
      amount: netProfit,
      currency: ctx.currency,
      categoryIds: scheduleC.lines.find((line) => line.line === "31")?.categoryIds ?? [],
      docCount: scheduleC.lines.find((line) => line.line === "31")?.docCount ?? 0,
      adjustmentNote:
        `Assumes the Schedule C draft as it stands, with ${openCount} open ` +
        `${openCount === 1 ? "item" : "items"} against it. Every figure below moves when that one ` +
        `does.`,
      openExceptionIds: scheduleC.openExceptionIds,
    },
    {
      line: "2",
      label: "Net earnings subject to self-employment tax",
      recorded: netProfit,
      amount: seBasis,
      currency: ctx.currency,
      categoryIds: [],
      docCount: 0,
      adjustmentNote: profitable
        ? `92.35 per cent of line 1, the statutory adjustment before self-employment tax. Assumes ` +
          `all of the net profit is self-employment earnings — no partner, no employee wages from ` +
          `this entity, no income excluded from self-employment.`
        : `Line 1 is not positive, so there are no net earnings to tax. A loss in ${ctx.period.label} ` +
          `is not a loss for the year, and this line will change when later periods are prepared.`,
      openExceptionIds: scheduleC.openExceptionIds,
    },
    {
      line: "3",
      label: "Self-employment tax at 15.3 per cent",
      recorded: seBasis,
      amount: seTax,
      currency: ctx.currency,
      categoryIds: [],
      docCount: 0,
      adjustmentNote:
        `15.3 per cent of line 2. Assumes the whole of line 2 falls below the Social Security wage ` +
        `base for the year and that no wages from other employment have used part of it, and ` +
        `assumes no Additional Medicare Tax. Both assumptions depend on facts outside this app; ` +
        `where either is wrong, the figure is high or low and a person has to say which.`,
      openExceptionIds: scheduleC.openExceptionIds,
    },
    {
      line: "4",
      label: "Deductible half of self-employment tax",
      recorded: seTax,
      amount: halfSeTax,
      currency: ctx.currency,
      categoryIds: [],
      docCount: 0,
      adjustmentNote:
        "Half of line 3. It is an adjustment to income on Schedule 1 of the 1040, not an expense " +
        "on Schedule C — it does not reduce the net profit on line 1 of this worksheet.",
      openExceptionIds: [],
    },
    {
      line: "5",
      label: "Estimated income tax — LEFT BLANK",
      /**
       * Both figures are zero because the type requires numbers, and both the
       * label and the note say the line is blank. Nothing in this file adds
       * line 5 to anything, and there is no total that would.
       */
      recorded: 0,
      amount: 0,
      currency: ctx.currency,
      categoryIds: [],
      docCount: 0,
      adjustmentNote:
        "No figure, on purpose. Income tax depends on filing status, other household income, " +
        "deductions, credits and payments already made — none of which this app holds, and none " +
        "of which appear on an invoice. The reviewer fills this line. A zero here would read as " +
        "no income tax due, which is the reason it is not written as one.",
      openExceptionIds: [],
    },
  ];

  return {
    id: draftId(ctx.period.id, "1040-es-worksheet"),
    periodId: ctx.period.id,
    formId: "1040-es-worksheet",
    formName: formName("1040-es-worksheet"),
    status: "draft",
    lines,
    /**
     * No "total estimated tax" and no quarterly payment. Both need line 5, and
     * a total that quietly treats a blank as a zero is worse than no total.
     */
    totals: [
      { label: "Net profit carried from Schedule C (line 31)", amount: netProfit, currency: ctx.currency },
      { label: "Self-employment tax (line 3)", amount: seTax, currency: ctx.currency },
      { label: "Deductible half (line 4)", amount: halfSeTax, currency: ctx.currency },
    ],
    openExceptionIds: scheduleC.openExceptionIds,
    /** Inherited: the net profit this worksheet rests on does not account for these. */
    unmappedCategoryIds: scheduleC.unmappedCategoryIds,
    generatedAt: ctx.generatedAt,
    generatedBy: ctx.generatedBy,
    disclaimer: DISCLAIMER,
  };
}

function formName(formId: string): string {
  return FORMS.find((form) => form.id === formId)?.name ?? formId;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Generation
 * ────────────────────────────────────────────────────────────────────────── */

async function buildDraft(formId: string, ctx: Context): Promise<FormDraft> {
  switch (formId) {
    case "schedule-c":
      return buildScheduleC(ctx);
    case "1099-nec-summary":
      return buildContractorSummary(ctx);
    case "1040-es-worksheet":
      /**
       * The worksheet recomputes Schedule C from the same context rather than
       * reading a stored draft. A stored one can be older than the documents —
       * somebody regenerates the 1040-ES after a re-extraction and the net
       * profit it quotes is last week's. Recomputing means the two drafts can
       * only ever disagree if the underlying figures changed between two calls,
       * and both are deterministic.
       */
      return buildEstimatedTax(ctx, buildScheduleC(ctx));
    default:
      throw new Error(
        `No form with id ${formId}. This build drafts ${FORMS.map((f) => f.id).join(", ")}.`,
      );
  }
}

/** Replace the draft for this period and form; never add a second row for it. */
async function persist(draft: FormDraft): Promise<FormDraft> {
  return mutate<FormDraft[], FormDraft>("forms", [], (rows) => ({
    next: [
      ...rows.filter((row) => !(row.periodId === draft.periodId && row.formId === draft.formId)),
      draft,
    ],
    result: draft,
  }));
}

export async function generateForm(
  formId: string,
  periodId: string,
  actor: string,
): Promise<FormDraft> {
  if (!FORM_IDS.has(formId)) {
    throw new Error(
      `No form with id ${formId}. This build drafts ${FORMS.map((f) => f.id).join(", ")}.`,
    );
  }

  const ctx = await buildContext(periodId, actor);
  const draft = await persist(await buildDraft(formId, ctx));

  await record({
    actor,
    action: "form.generate",
    subject: draft.id,
    result: "ok",
    periodId,
    detail:
      `Drafted ${draft.formName} from ${draft.lines.reduce((n, l) => n + l.docCount, 0)} document ` +
      `references, with ${draft.openExceptionIds.length} open ` +
      `${draft.openExceptionIds.length === 1 ? "item" : "items"} against it and ` +
      `${draft.unmappedCategoryIds.length} ${
        draft.unmappedCategoryIds.length === 1 ? "category" : "categories"
      } on no line. Status draft; nothing filed.`,
  });

  return draft;
}

/**
 * All three, in order.
 *
 * Sequential rather than parallel: they share one `forms.json` and `mutate`
 * serialises writes to it anyway, so running them concurrently would buy
 * nothing and make the audit rows arrive in an order that does not match the
 * order they were computed in.
 */
export async function generateAllForms(periodId: string, actor: string): Promise<FormDraft[]> {
  const drafts: FormDraft[] = [];
  for (const form of FORMS) {
    drafts.push(await generateForm(form.id, periodId, actor));
  }
  return drafts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rendering
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The markdown a reviewer reads, and the markdown that goes into the package.
 *
 * The order is deliberate. The draft mark and the disclaimer come before any
 * figure, then the count of open items, then the lines. A rendering that opens
 * with a net profit has already told the reader the answer, and everything
 * after it reads as supporting detail rather than as the reasons not to trust
 * it yet.
 */
export function renderFormMarkdown(draft: FormDraft): string {
  const currency = draft.lines[0]?.currency ?? draft.totals[0]?.currency ?? "USD";
  const out: string[] = [];

  out.push(`## ${draft.formName}`);
  out.push("");
  out.push(`**DRAFT — not filed.** ${draft.disclaimer}`);
  out.push("");

  const preamble = PREAMBLES[draft.formId];
  if (preamble) {
    out.push(preamble);
    out.push("");
  }

  const open = draft.openExceptionIds.length;
  out.push(
    open === 0
      ? "No open items are recorded against this draft. That means nothing was flagged, not that it has been reviewed."
      : `**${open} open ${open === 1 ? "item is" : "items are"} recorded against this draft.** ` +
          "No line below is final while any of them stands.",
  );
  out.push("");

  out.push(`| Line | Item | Docs | Recorded | On the line |`);
  out.push(`| --- | --- | ---: | ---: | ---: |`);
  for (const line of draft.lines) {
    const adjusted = Math.abs(line.recorded - line.amount) >= 0.005;
    out.push(
      `| ${line.line} | ${escapeCell(line.label)} | ${line.docCount || "—"} | ${money(
        line.recorded,
        line.currency,
      )} | ${money(line.amount, line.currency)}${adjusted ? " ¹" : ""} |`,
    );
  }
  out.push("");

  const notes = draft.lines.filter((line) => line.adjustmentNote);
  if (notes.length) {
    out.push("### Notes on the lines");
    out.push("");
    for (const line of notes) {
      out.push(`- **Line ${line.line}, ${line.label}.** ${line.adjustmentNote}`);
    }
    out.push("");
  }

  if (draft.totals.length) {
    out.push("### Totals");
    out.push("");
    for (const total of draft.totals) {
      out.push(`- ${total.label}: **${money(total.amount, total.currency)}**`);
    }
    out.push("");
  }

  if (draft.unmappedCategoryIds.length) {
    out.push("### Money on no line of this form");
    out.push("");
    out.push(
      "Recorded in the period and accounted for by nothing above. It is not missing and it is " +
        "not deducted here — a person decides where each of these belongs.",
    );
    out.push("");
    for (const categoryId of draft.unmappedCategoryIds) {
      const category = getCategory(categoryId);
      out.push(
        `- **${categoryName(categoryId)}** — ${category?.formLine ?? "no line mapped"}. ${
          category?.description ?? ""
        }`.trim(),
      );
    }
    out.push("");
  }

  out.push(
    `_Drafted ${draft.generatedAt} by ${draft.generatedBy}. Figures in ${currency}. ` +
      `Status: ${draft.status}._`,
  );

  return out.join("\n");
}

/** What a reader has to know about a form before they read its numbers. */
const PREAMBLES: Record<string, string> = {
  "schedule-c":
    "Every figure is a sum over the categorised documents. Where a line shows a different amount " +
    "from what was recorded, the note under the table says which rule moved it and by how much — " +
    "no line was adjusted silently.",
  "1099-nec-summary":
    "**This is a summary, not a 1099.** Nothing here has been issued to a contractor or filed with " +
    "anyone. The reporting threshold is annual; this worksheet covers one period, so a vendor " +
    "below it here can still cross it over the year.",
  "1040-es-worksheet":
    "Self-employment tax is computed from the Schedule C draft. The income-tax line is left blank " +
    "because it depends on facts this app does not hold, and there is no grand total for the same " +
    "reason — a total with a blank in it is not a total.",
};

/** Pipes and newlines inside a cell would break the table apart. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
