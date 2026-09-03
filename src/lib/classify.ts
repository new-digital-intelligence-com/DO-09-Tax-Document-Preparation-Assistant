import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { record } from "./audit";
import { MODEL, TOKEN_BUDGET, completeStructured, explainModelError, modelConfigured } from "./anthropic";
import { CATEGORIES, categoryName, categoryPrompt, deductibleFraction, getCategory } from "./categories";
import { listDocuments } from "./documents";
import { getExtraction, listExtractions } from "./extract";
import { activePeriod, getPeriod, getSettings, money } from "./settings";
import { mutate, readStore } from "./store";
import { effectiveCategoryId } from "./types";
import type {
  CategoryKind,
  Classification,
  Extraction,
  SourceDocument,
  TaxCategory,
} from "./types";

/**
 * Placing a document on the chart of tax categories.
 *
 * The classifier decides which Schedule C line a figure reaches, and that is
 * the whole of its authority. It does not decide whether a figure is
 * deductible, what fraction of a phone bill is business, or whether a laptop is
 * an expense or an asset — `TaxCategory.alwaysReview` marks the categories
 * where the question is a judgement call, and anything landing on one of them
 * is routed to a person no matter how sure the model was.
 *
 * That last rule is the one worth stating twice. A confident answer to the
 * wrong kind of question is not a reason to skip the human; it is the reason
 * the human is needed. `needsReview` fires on `alwaysReview` before it looks at
 * a confidence score at all.
 *
 * Batched: one call carries up to `TOKEN_BUDGET.classifyBatch` extractions.
 * Categorisation is a comparison against a fixed chart, and sending the chart
 * once per document would spend most of the budget re-reading it.
 */

/**
 * A reading confidence below this makes the categorisation untrustworthy too.
 *
 * Separate from, and lower than, `Settings.reviewConfidence`. They answer
 * different questions: reviewConfidence asks whether the category is right,
 * this floor asks whether the text the category was chosen from was read
 * correctly. A category chosen with total conviction from a total the model
 * half-read is worth no more than the total was.
 */
const EXTRACTION_REVIEW_FLOOR = 0.6;

/** The escape hatch on the chart. Nothing is forced onto a line to look complete. */
const UNCATEGORISED = "uncategorised";

/**
 * The `modelId` written on a row the model never saw.
 *
 * An unreadable document is categorised here in code, not by a call. Recording
 * the model's name on that row would attribute an answer to something that was
 * never asked, and a reviewer tracing a disputed placement would go looking for
 * a call that does not exist.
 */
const NO_MODEL = "none (not sent to the model)";

/** Form order: income, then cost of sales, then expenses, then the off-form kinds. */
const KIND_ORDER: Record<CategoryKind, number> = {
  income: 0,
  cogs: 1,
  expense: 2,
  asset: 3,
  "non-deductible": 4,
};

/* ────────────────────────────────────────────────────────────────────────────
 * The tool
 * ────────────────────────────────────────────────────────────────────────── */

const CATEGORY_IDS = CATEGORIES.map((category) => category.id);

/**
 * One tool call carries the whole batch.
 *
 * `categoryId` is an enum of the actual chart rather than a free string, so a
 * category the model invented is rejected by the API instead of being written
 * to a row and silently dropped out of every total later. `docId` is required
 * on each entry because a batch answer without ids can only be matched back by
 * position, and a model that returns eleven answers for twelve documents would
 * then shift every one of them onto the wrong file.
 */
export const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "record_categories",
  description:
    "Assign one tax category to each document in the batch. Answer for every document you were " +
    "given, and use its exact docId.",
  input_schema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        description: "One entry per document in the batch, in any order.",
        items: {
          type: "object",
          properties: {
            docId: {
              type: "string",
              description: "The exact document id from the batch, copied character for character.",
            },
            categoryId: {
              type: "string",
              enum: CATEGORY_IDS,
              description:
                "The category this document belongs to. Use 'uncategorised' when nothing on the " +
                "chart describes it — that is a correct answer, and it puts the document on the " +
                "reviewer's list rather than on a form line.",
            },
            confidence: {
              type: "number",
              description:
                "0 to 1: how sure you are that this category is the right one, given what was " +
                "read off the document. Not how sure you are the document was read correctly.",
            },
            rationale: {
              type: "string",
              description:
                "One sentence, drawn from the document's own contents — the vendor, a line item, " +
                "the amount. A reviewer reads this next to the document and has to be able to " +
                "check it. 'It looks like software' is not checkable; 'the line items name a " +
                "monthly Figma seat' is.",
            },
            alternatives: {
              type: "array",
              description:
                "The categories you weighed this against and rejected, strongest first. Two is " +
                "usually enough. An empty list means nothing else was close.",
              items: {
                type: "object",
                properties: {
                  categoryId: { type: "string", enum: CATEGORY_IDS },
                  confidence: { type: "number", description: "0 to 1." },
                },
                required: ["categoryId", "confidence"],
              },
            },
          },
          required: ["docId", "categoryId", "confidence", "rationale"],
        },
      },
    },
    required: ["assignments"],
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * The prompt
 * ────────────────────────────────────────────────────────────────────────── */

const CLASSIFY_SYSTEM = [
  "You place financial documents on a fixed chart of tax categories. That is the whole of your",
  "authority, and the boundaries of it matter more than the accuracy.",
  "",
  "What you decide: which category on the chart best describes what the document is for.",
  "",
  "What you never decide: whether an amount is deductible, what fraction of a shared cost is",
  "business, whether a purchase should be capitalised or expensed, whether something is",
  "personal, or anything else that would count as tax advice. Several categories on the chart",
  "are marked ALWAYS route to a human. Choosing one of those is the correct action when it is",
  "the right description — it does not decide the question, it routes the document to the person",
  "who will. Do not steer away from those categories to avoid raising a flag, and do not steer",
  "towards them to avoid committing.",
  "",
  "Rules.",
  "",
  "1. Choose from the chart only, using the exact ids given. Nothing else is a category.",
  "",
  "2. When nothing on the chart describes the document, answer 'uncategorised'. That is a real",
  "   answer and the right one. Picking the nearest plausible line so the draft looks complete",
  "   puts a figure on a tax form that nobody chose to put there.",
  "",
  "3. Judge from what was read off the document — the vendor, the line items, the amount, the",
  "   direction of the money. Not from the filename, which was typed by whoever saved the file",
  "   and is often wrong.",
  "",
  "4. confidence is your confidence in the category, given what was read. It is not a judgement",
  "   about how well the document was read; a separate reading confidence is shown to you and",
  "   is handled elsewhere. Report a low number when the evidence is thin. A flag costs a",
  "   reviewer a minute; a wrong category costs a corrected return.",
  "",
  "5. The rationale is read by a person holding the document. Quote what is actually on it.",
  "",
  "6. Direction decides more than it looks. An invoice this business issued is income even when",
  "   the vendor field names a familiar supplier, and a credit note is not a negative expense.",
  "",
  "Answer for every document in the batch, using its exact id.",
].join("\n");

/** One document as the classifier sees it: what was read, and nothing that was not. */
function describe(doc: SourceDocument, extraction: Extraction, currency: string): string {
  const lines: string[] = [`[${doc.id}] ${doc.filename}`];

  lines.push(
    `  type: ${extraction.docType}; direction: ${extraction.direction}; ` +
      `reading confidence ${extraction.confidence.toFixed(2)}`,
  );
  lines.push(`  vendor/counterparty: ${extraction.vendor ?? "not read"}`);
  if (extraction.invoiceNumber) lines.push(`  reference: ${extraction.invoiceNumber}`);
  lines.push(`  date: ${extraction.issueDate ?? "not read"}`);
  lines.push(
    `  total: ${
      typeof extraction.total === "number"
        ? money(extraction.total, extraction.currency ?? currency)
        : "not read"
    }`,
  );
  if (extraction.periodStart || extraction.periodEnd) {
    lines.push(
      `  service period: ${extraction.periodStart ?? "?"} to ${extraction.periodEnd ?? "?"}`,
    );
  }
  if (extraction.lineItems.length > 0) {
    // Six is enough to characterise a document. A forty-line hosting invoice
    // spends the batch's budget on rows that all say the same thing.
    const shown = extraction.lineItems.slice(0, 6);
    lines.push("  line items:");
    for (const item of shown) {
      lines.push(
        `    - ${item.description}${typeof item.amount === "number" ? ` — ${item.amount}` : ""}`,
      );
    }
    if (extraction.lineItems.length > shown.length) {
      lines.push(`    - (${extraction.lineItems.length - shown.length} further line(s) not shown)`);
    }
  }
  if (extraction.notes) lines.push(`  extractor's notes: ${extraction.notes}`);
  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the store
 * ────────────────────────────────────────────────────────────────────────── */

export async function listClassifications(periodId?: string): Promise<Classification[]> {
  const rows = await readStore<Classification[]>("classifications", []);
  if (!periodId) return [...rows].sort((a, b) => a.docId.localeCompare(b.docId));

  const inScope = new Set((await listDocuments({ periodId })).map((doc) => doc.id));
  return rows
    .filter((row) => inScope.has(row.docId))
    .sort((a, b) => a.docId.localeCompare(b.docId));
}

export async function getClassification(docId: string): Promise<Classification | undefined> {
  return (await readStore<Classification[]>("classifications", [])).find(
    (row) => row.docId === docId,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The review verdict
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a person has to look at this categorisation, and why.
 *
 * The order of the tests is the order of the reasons a reviewer reads, worst
 * first, and every test that fires contributes a sentence — a document can be
 * flagged for more than one reason and reporting only the first would send
 * someone to check a confidence score when the real problem was that the page
 * could not be read.
 *
 * `alwaysReview` is checked without reference to any confidence at all. Those
 * categories are judgement calls by nature: the model being sure that a laptop
 * is a laptop says nothing about whether it should be expensed or capitalised,
 * and treating high confidence as grounds to skip the reviewer would route the
 * clearest cases — the ones the reviewer most needs to decide — around them.
 */
function reviewVerdict(input: {
  category: TaxCategory | undefined;
  categoryConfidence: number;
  extraction: Extraction;
  threshold: number;
}): { needsReview: boolean; reviewReason?: string } {
  const reasons: string[] = [];
  const { category, categoryConfidence, extraction, threshold } = input;

  if (extraction.status !== "extracted") {
    reasons.push(
      `The document came back ${extraction.status} from extraction, so any category on it is a ` +
        `placeholder rather than a reading. ${extraction.statusDetail ?? ""}`.trim(),
    );
  }

  if (!category) {
    reasons.push(
      "The category recorded against this document is not on the chart, so it reaches no form " +
        "line until a person places it.",
    );
  } else if (category.alwaysReview) {
    reasons.push(
      `${category.name} always goes to a person, whatever the confidence: ` +
        `${category.reviewReason ?? "the category is a judgement call by nature."}`,
    );
  }

  if (categoryConfidence < threshold) {
    reasons.push(
      `Category confidence ${categoryConfidence.toFixed(2)} is below the ${threshold.toFixed(2)} ` +
        "threshold set for this workspace.",
    );
  }

  if (extraction.status === "extracted" && extraction.confidence < EXTRACTION_REVIEW_FLOOR) {
    reasons.push(
      `The document was read at only ${extraction.confidence.toFixed(2)} confidence, below the ` +
        `${EXTRACTION_REVIEW_FLOOR.toFixed(2)} floor, so the figures the category was chosen ` +
        "from may not be the figures on the page.",
    );
  }

  return {
    needsReview: reasons.length > 0,
    reviewReason: reasons.length > 0 ? reasons.join(" ") : undefined,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalising an answer
 * ────────────────────────────────────────────────────────────────────────── */

function fraction(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const scaled = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, scaled));
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Runners-up, kept only where they name a real category. */
function alternativesOf(value: unknown): { categoryId: string; confidence: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const categoryId = text(row.categoryId);
      if (!categoryId || !getCategory(categoryId)) return undefined;
      return { categoryId, confidence: fraction(row.confidence) };
    })
    .filter((row): row is { categoryId: string; confidence: number } => row !== undefined)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
}

/** Replace by docId, never append blindly — two rows for one document split every total. */
async function saveClassifications(rows: Classification[]): Promise<void> {
  if (rows.length === 0) return;
  const incoming = new Map(rows.map((row) => [row.docId, row]));
  await mutate<Classification[], void>("classifications", [], (current) => ({
    next: [
      ...current.map((row) => incoming.get(row.docId) ?? row),
      ...rows.filter((row) => !current.some((existing) => existing.docId === row.docId)),
    ],
    result: undefined,
  }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Running a period
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Categorise everything read but not yet placed.
 *
 * Pending means an extraction with no classification row. A document that
 * already has one is left alone, which is what protects a human override: a
 * second run must never quietly replace a category a person chose and signed a
 * note for. Re-categorising is a deliberate act through `overrideCategory`.
 *
 * Documents whose extraction came back `unreadable` or `failed` are placed here
 * in code and never sent to the model. There is nothing to categorise from, and
 * asking anyway would return a category derived from a filename and a document
 * type — which is precisely the guess the extractor refused to make.
 */
/**
 * The batch's answers, whatever shape they arrive in.
 *
 * Two failure modes, both silent, both observed on real runs.
 *
 * The first is shape. A forced tool call validates the top-level schema but not
 * the model's idea of how to fill it, and Haiku will sometimes serialise an
 * array-of-objects property as a JSON *string* rather than an array. The call
 * is accepted, `Array.isArray` is false, and the batch comes back with no
 * answers.
 *
 * The second is truncation. Stringifying the array doubles every quote, so a
 * batch that would have fitted as an array overruns `max_tokens` as a string
 * and arrives cut off mid-entry. `JSON.parse` then rejects the whole thing,
 * including the ten entries that were complete.
 *
 * Both end the same way: a dozen documents recorded as uncategorised at zero
 * confidence, a run that reports success, and nothing on screen saying the
 * model actually answered. So the string form is parsed, and a string that will
 * not parse is scanned for the objects that did complete. What is recovered is
 * used; what was cut off stays uncategorised and flagged, which is the honest
 * outcome for an answer that never arrived.
 */
function assignmentsOf(value: unknown): Record<string, unknown>[] {
  const asRows = (candidate: unknown): Record<string, unknown>[] =>
    Array.isArray(candidate)
      ? candidate.filter(
          (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
        )
      : [];

  if (Array.isArray(value)) return asRows(value);
  if (typeof value !== "string") return [];

  try {
    return asRows(JSON.parse(value));
  } catch {
    return salvage(value);
  }
}

/**
 * Complete top-level objects out of a truncated JSON array.
 *
 * Brace-counting rather than a regular expression, because a rationale is free
 * text and will contain braces and escaped quotes of its own. Only objects that
 * closed are returned — a half-written entry is dropped, never patched up into
 * a category assignment nobody made.
 */
function salvage(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const row = JSON.parse(text.slice(start, i + 1));
          if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
        } catch {
          // A top-level object that will not parse on its own is not an answer.
        }
        start = -1;
      }
    }
  }

  return rows;
}

export async function classifyPending(
  periodId: string,
  actor: string,
  limit?: number,
): Promise<{
  run: number;
  classified: number;
  needsReview: number;
  results: Classification[];
}> {
  const [settings, docs, extractions, existing] = await Promise.all([
    getSettings(),
    listDocuments({ periodId }),
    listExtractions(periodId),
    readStore<Classification[]>("classifications", []),
  ]);
  const period = (await getPeriod(periodId)) ?? (await activePeriod());

  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  const classified = new Set(existing.map((row) => row.docId));
  const threshold = settings.reviewConfidence;

  const pending = extractions.filter((row) => docById.has(row.docId) && !classified.has(row.docId));
  const selected = typeof limit === "number" && limit >= 0 ? pending.slice(0, limit) : pending;

  const results: Classification[] = [];
  const now = () => new Date().toISOString();

  /** Placed without a call: an unreadable page carries nothing to categorise from. */
  const unreadable = selected.filter((row) => row.status !== "extracted");
  for (const extraction of unreadable) {
    const verdict = reviewVerdict({
      category: getCategory(UNCATEGORISED),
      categoryConfidence: 0,
      extraction,
      threshold,
    });
    results.push({
      docId: extraction.docId,
      categoryId: UNCATEGORISED,
      confidence: 0,
      rationale:
        `The document came back ${extraction.status} from extraction, so it was not sent to ` +
        "the classifier. It stays off every form line until a person reads it and places it.",
      alternatives: [],
      needsReview: verdict.needsReview,
      reviewReason: verdict.reviewReason,
      classifiedAt: now(),
      modelId: NO_MODEL,
    });
  }

  const readable = selected.filter((row) => row.status === "extracted");

  if (readable.length > 0 && !modelConfigured()) {
    // Stop before the loop rather than writing a placeholder row per document.
    // A missing key is a deployment fault, and recording it as thirty
    // uncategorised documents blames the corpus for it.
    throw new Error(
      "The assistant's API key is not set, so nothing can be categorised. Copy .env.example to " +
        ".env.local and fill in ANTHROPIC_API_KEY.",
    );
  }

  const chart = categoryPrompt();

  for (let index = 0; index < readable.length; index += TOKEN_BUDGET.classifyBatch) {
    const batch = readable.slice(index, index + TOKEN_BUDGET.classifyBatch);
    const prompt = [
      "The chart of tax categories. Choose from these ids and no others.",
      "",
      chart,
      "",
      "────────────────────────────────────────",
      "",
      `Entity: ${period.entity}. Filing period ${period.label} (${period.start} to ` +
        `${period.end}), ${period.basis} basis, reported in ${period.currency}.`,
      "",
      `${batch.length} document(s) to categorise. Everything below was read off the documents ` +
        "themselves; a field reading 'not read' was not legible, and is not something to fill in.",
      "",
      batch
        .map((extraction) =>
          describe(docById.get(extraction.docId)!, extraction, period.currency),
        )
        .join("\n\n"),
    ].join("\n");

    let answers: Record<string, unknown>[] = [];
    let raw = "";
    try {
      const response = await completeStructured<{ assignments?: unknown }>({
        system: CLASSIFY_SYSTEM,
        prompt,
        tool: CLASSIFY_TOOL,
        maxTokens: TOKEN_BUDGET.maxTokens,
      });
      raw = response.raw;
      answers = assignmentsOf(response.value?.assignments);
    } catch (error) {
      const explained = explainModelError(error);
      // Keep whatever this run has already decided. The unreadable placeholders
      // in particular are findings, and losing them because a later batch hit a
      // rate limit would hide documents the reviewer needs to see.
      await saveClassifications(results);
      await record({
        actor,
        action: "classify.error",
        subject: periodId,
        result: "error",
        detail:
          `A batch of ${batch.length} document(s) could not be categorised: ${explained.message}. ` +
          "They remain uncategorised and will be picked up by the next run.",
        periodId,
      });
      // Leave the batch pending rather than writing a guess. An uncategorised
      // document is visible on the console; a wrongly categorised one is not.
      throw new Error(explained.message);
    }

    const byDoc = new Map<string, Record<string, unknown>>();
    for (const answer of answers) {
      const docId = text(answer.docId);
      if (docId) byDoc.set(docId, answer);
    }

    for (const extraction of batch) {
      const answer = byDoc.get(extraction.docId);
      const claimed = text(answer?.categoryId);
      const category = claimed ? getCategory(claimed) : undefined;

      // A missing answer, or one naming a category that is not on the chart,
      // becomes uncategorised with the reason stated. Silently dropping the
      // document would leave it out of every total with nothing on screen
      // saying why.
      const categoryId = category ? claimed! : UNCATEGORISED;
      const confidence = category ? fraction(answer?.confidence) : 0;
      const rationale = answer
        ? category
          ? text(answer.rationale) ??
            "The model gave no rationale for this category, which is itself a reason to check it."
          : `The model answered "${claimed ?? "nothing"}", which is not a category on the chart.`
        : "The model returned no answer for this document in its batch.";

      const verdict = reviewVerdict({
        category: getCategory(categoryId),
        categoryConfidence: confidence,
        extraction,
        threshold,
      });

      results.push({
        docId: extraction.docId,
        categoryId,
        confidence,
        rationale,
        alternatives: alternativesOf(answer?.alternatives),
        needsReview: verdict.needsReview,
        reviewReason: verdict.reviewReason,
        classifiedAt: now(),
        modelId: category ? MODEL : NO_MODEL,
      });
    }

    if (answers.length !== batch.length) {
      await record({
        actor,
        action: "classify.partial-batch",
        subject: periodId,
        result: "info",
        detail:
          `A batch of ${batch.length} document(s) came back with ${answers.length} answer(s). ` +
          "The documents with no answer were recorded as uncategorised and flagged, not " +
          `dropped. Raw answer: ${raw.slice(0, 400)}`,
        periodId,
      });
    }
  }

  await saveClassifications(results);

  const flagged = results.filter((row) => row.needsReview).length;
  await record({
    actor,
    action: "classify.run",
    subject: periodId,
    result: "ok",
    detail:
      `Categorised ${results.length} of ${pending.length} document(s) awaiting a category ` +
      `(${extractions.length} read in the period): ${flagged} flagged for review, ` +
      `${unreadable.length} placed as uncategorised because they could not be read. ` +
      "Documents already carrying a category, including ones a person overrode, were left alone.",
    periodId,
  });

  return { run: selected.length, classified: results.length, needsReview: flagged, results };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Human override
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A person moves a document to a different category.
 *
 * The model's answer is kept. `categoryId`, `confidence`, `rationale` and the
 * alternatives all stay exactly as they were, and the human's choice goes in
 * the `overridden*` fields — `effectiveCategoryId` is what everything
 * downstream reads. Overwriting the original would erase the disagreement,
 * which is the only record of how well the classifier is doing.
 *
 * The note is required and refused when blank. There is no password on this
 * action and no shared secret; what protects it is that the console states the
 * consequence, the person types why, and the note lands in the audit trail
 * under their name. A move with no reason is indistinguishable six months later
 * from a misclick.
 */
/**
 * Categorise one document, now.
 *
 * The batch path is the right shape for a period sweep and the wrong shape for
 * an upload: somebody who has just dropped a receipt on the page is waiting for
 * an answer, and filling a batch of six would mean waiting for five documents
 * that do not exist.
 *
 * It is the same chart, the same tool and the same prompt as a batch of one, so
 * an upload and a sweep cannot disagree about where a document belongs. What it
 * does not do is call the model for an extraction that has nothing in it — an
 * unreadable scan, a page declined as out of scope, or a failure — because
 * there is nothing on such a row to categorise from, and a category chosen out
 * of a blank is a guess wearing a confidence score.
 */
export async function classifyDocument(docId: string, actor: string): Promise<Classification> {
  const [settings, extraction, docs] = await Promise.all([
    getSettings(),
    getExtraction(docId),
    listDocuments(),
  ]);

  if (!extraction) {
    throw new Error(
      `${docId} has not been read yet, so there is nothing to categorise. Run extraction first.`,
    );
  }

  const doc = docs.find((row: SourceDocument) => row.id === docId);
  if (!doc) throw new Error(`No document ${docId} on the register.`);

  const period = (await getPeriod(doc.periodId)) ?? (await activePeriod());
  const threshold = settings.reviewConfidence;
  const now = new Date().toISOString();

  /** Placed in code, not by a call. Mirrors the batch path exactly. */
  const place = (categoryId: string, confidence: number, rationale: string, modelId: string) => {
    const verdict = reviewVerdict({
      category: getCategory(categoryId),
      categoryConfidence: confidence,
      extraction,
      threshold,
    });
    return {
      docId,
      categoryId,
      confidence,
      rationale,
      alternatives: [],
      needsReview: verdict.needsReview,
      reviewReason: verdict.reviewReason,
      classifiedAt: now,
      modelId,
    } satisfies Classification;
  };

  if (extraction.status !== "extracted") {
    const row = place(
      UNCATEGORISED,
      0,
      extraction.status === "out-of-scope"
        ? "The document was declined as not a financial record, so it was never sent to the " +
          "classifier. It stays off every form line."
        : `The document came back ${extraction.status} from extraction, so it was not sent to ` +
          "the classifier. It stays off every form line until a person reads it and places it.",
      NO_MODEL,
    );
    await saveClassifications([row]);
    return row;
  }

  if (!modelConfigured()) {
    throw new Error(
      "The assistant's API key is not set, so nothing can be categorised. Copy .env.example to " +
        ".env.local and fill in ANTHROPIC_API_KEY.",
    );
  }

  const prompt = [
    "The chart of tax categories. Choose from these ids and no others.",
    "",
    categoryPrompt(),
    "",
    "────────────────────────────────────────",
    "",
    `Entity: ${period.entity}. Filing period ${period.label} (${period.start} to ${period.end}), ` +
      `${period.basis} basis, reported in ${period.currency}.`,
    "",
    "1 document to categorise. Everything below was read off the document itself; a field " +
      "reading 'not read' was not legible, and is not something to fill in.",
    "",
    describe(doc, extraction, period.currency),
  ].join("\n");

  const response = await completeStructured<{ assignments?: unknown }>({
    system: CLASSIFY_SYSTEM,
    prompt,
    tool: CLASSIFY_TOOL,
    maxTokens: TOKEN_BUDGET.maxTokens,
  });

  const answer = assignmentsOf(response.value?.assignments).find(
    (row) => text(row.docId) === docId,
  );
  const claimed = text(answer?.categoryId);
  const category = claimed ? getCategory(claimed) : undefined;

  const row: Classification = {
    ...place(
      category ? claimed! : UNCATEGORISED,
      category ? fraction(answer?.confidence) : 0,
      answer
        ? category
          ? (text(answer.rationale) ??
            "The model gave no rationale for this category, which is itself a reason to check it.")
          : `The model answered "${claimed ?? "nothing"}", which is not a category on the chart.`
        : "The model returned no answer for this document.",
      category ? MODEL : NO_MODEL,
    ),
    alternatives: alternativesOf(answer?.alternatives),
  };

  await saveClassifications([row]);
  await record({
    actor,
    action: "classify.one",
    subject: docId,
    result: "ok",
    detail:
      `${doc.filename} categorised as ${categoryName(row.categoryId)} at ` +
      `${row.confidence.toFixed(2)}${row.needsReview ? ", flagged for review" : ""}.`,
    periodId: doc.periodId,
    docId,
  });

  return row;
}

export async function overrideCategory(input: {
  docId: string;
  categoryId: string;
  actor: string;
  note: string;
}): Promise<Classification> {
  const note = input.note?.trim() ?? "";
  if (!note) {
    throw new Error(
      "Changing a document's category needs a note saying why. It is written to the audit trail.",
    );
  }

  const category = getCategory(input.categoryId);
  if (!category) {
    throw new Error(
      `${input.categoryId} is not a category on the chart. Nothing was changed.`,
    );
  }

  const existing = await getClassification(input.docId);
  if (!existing) {
    throw new Error(
      `${input.docId} has no categorisation to override. Run the classifier on it first, so the ` +
        "model's answer is on file next to yours.",
    );
  }

  const at = new Date().toISOString();
  const updated: Classification = {
    ...existing,
    overriddenCategoryId: category.id,
    overriddenBy: input.actor,
    overriddenAt: at,
    overrideNote: note,
    /**
     * The flag comes down. It meant "no person has looked at this category",
     * and one now has, with their name and their reason on the row. Leaving it
     * raised would teach reviewers that the review list does not shrink when
     * they work it, and a list like that gets ignored. The category-level
     * findings are a separate matter: the exception engine re-raises
     * `category-needs-judgement` from the effective category on its own terms.
     */
    needsReview: false,
    reviewReason: undefined,
  };

  await mutate<Classification[], void>("classifications", [], (rows) => ({
    next: rows.map((row) => (row.docId === input.docId ? updated : row)),
    result: undefined,
  }));

  const doc = (await listDocuments()).find((row) => row.id === input.docId);
  await record({
    actor: input.actor,
    action: "classify.override",
    subject: input.docId,
    result: "ok",
    detail:
      `${doc?.filename ?? input.docId} moved from ${existing.categoryId} ` +
      `(model, confidence ${existing.confidence.toFixed(2)}) to ${category.id} — ` +
      `${category.name}, ${category.formLine}. The model's answer is kept on the row. ` +
      `Reason: ${note}`,
    periodId: doc?.periodId,
    docId: input.docId,
  });

  return updated;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Totals
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What each category adds up to, recorded and deductible.
 *
 * Two figures, never one. `recorded` is what the documents say; `deductible` is
 * what reaches a form line after `deductibleFraction` — 50% for meals, nothing
 * at all for an asset or a non-deductible category. Showing only the second
 * makes a reviewer unable to tie a total back to the receipts; showing only the
 * first puts the wrong number on the return.
 *
 * A document whose extraction states a currency the period does not report in
 * is left out of the sums entirely, and its own count with it. This app does
 * not convert: an exchange rate is a decision about a date and a source, and
 * quietly picking one would put a figure on a tax form that no document
 * supports. Those documents are raised as `currency-mismatch` exceptions
 * instead. An extraction that states no currency at all is treated as the
 * period's, matching what the exception engine does — an unstated currency is
 * not a foreign one.
 *
 * A document with a category but no total still counts in `docCount`. Dropping
 * it would make the count agree with the money and disagree with the corpus,
 * and the reviewer would never learn that a document reached this line carrying
 * no figure.
 */
export async function categoryTotals(periodId: string): Promise<
  {
    categoryId: string;
    name: string;
    kind: CategoryKind;
    recorded: number;
    deductible: number;
    docCount: number;
  }[]
> {
  const [docs, extractions, classifications] = await Promise.all([
    listDocuments({ periodId }),
    listExtractions(periodId),
    listClassifications(periodId),
  ]);
  const period = (await getPeriod(periodId)) ?? (await activePeriod());
  const reporting = period.currency.trim().toUpperCase();

  const docIds = new Set(docs.map((doc) => doc.id));
  const extractionByDoc = new Map(extractions.map((row) => [row.docId, row]));

  const totals = new Map<
    string,
    { categoryId: string; name: string; kind: CategoryKind; recorded: number; deductible: number; docCount: number }
  >();

  for (const classification of classifications) {
    if (!docIds.has(classification.docId)) continue;

    const categoryId = effectiveCategoryId(classification);
    const category = getCategory(categoryId);
    if (!category) continue;

    const extraction = extractionByDoc.get(classification.docId);
    const declared = extraction?.currency?.trim().toUpperCase();
    if (declared && declared !== reporting) continue;

    const row = totals.get(categoryId) ?? {
      categoryId,
      name: category.name,
      kind: category.kind,
      recorded: 0,
      deductible: 0,
      docCount: 0,
    };

    row.docCount += 1;
    if (extraction?.status === "extracted" && typeof extraction.total === "number") {
      row.recorded += extraction.total;
      row.deductible += extraction.total * deductibleFraction(categoryId);
    }
    totals.set(categoryId, row);
  }

  return [...totals.values()]
    .map((row) => ({
      ...row,
      // Rounded once, at the end. Summing already-rounded figures drifts, and a
      // Schedule C line that is a cent off its own receipts is a question a
      // reviewer has to chase down.
      recorded: Math.round(row.recorded * 100) / 100,
      deductible: Math.round(row.deductible * 100) / 100,
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        b.recorded - a.recorded ||
        a.name.localeCompare(b.name),
    );
}
