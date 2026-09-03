import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { modelConfigured } from "./anthropic";
import { CATEGORIES } from "./categories";
import { categoryTotals } from "./classify";
import { documentViews, listDocuments, sourceBreakdown } from "./documents";
import { listExceptions } from "./exceptions";
import { FORMS, getForm, listForms, renderFormMarkdown } from "./forms";
import { listLedger } from "./ledger";
import { listMatches, reconciliationSummary } from "./reconcile";
import { listPackages } from "./packages";
import { activePeriod, getPeriod, getSettings } from "./settings";
import { effectiveCategoryId } from "./types";
import type { DocumentView } from "./types";

/**
 * The app's tools, and the whole of the agent's authority.
 *
 * What is in this list matters less than what is not. There is no
 * `resolve_exception`, no `override_category`, no `file_return`, no
 * `edit_ledger`, no `assemble_package` and no `hand_off`. The agent can read
 * every document, every figure, every match and every flag, explain any of
 * them, and say what it would do — and that is the end of it.
 *
 * Each absence is deliberate, and each has a reason:
 *
 *   `resolve_exception` — closing a flag is the one action that removes a
 *   question from a human's list. It requires a person, a dialog stating the
 *   consequence, and a typed note that lands in the audit trail. An agent
 *   closing its own findings is an agent marking its own homework.
 *
 *   `override_category` — a category decides which line a figure lands on and
 *   at what fraction. The model already proposed one, with a confidence and a
 *   rationale; letting it also confirm its own proposal would collapse the two
 *   steps that make the confidence worth reading.
 *
 *   `file_return` and any `mark_final` — nothing in this codebase files
 *   anything. There is no such tool to withhold, and there is no such code
 *   path to reach. `FormDraft.status` has one value.
 *
 *   `edit_ledger` — the accounting system is read-only fact here. Adjusting an
 *   amount so two figures agree is how a discrepancy stops being visible, and
 *   the discrepancy is the product.
 *
 *   `assemble_package` and `hand_off` — a package is what a person sends to a
 *   named reviewer under their own name. An agent that could assemble and hand
 *   one off could put a quarter's paperwork in front of a tax manager with
 *   nobody having looked at it.
 *
 * All of that is enforced by absence rather than by instruction, because an
 * instruction is a request and a missing tool is a fact. No phrasing, however
 * insistent, reaches a function that was never handed over.
 *
 * `get_form_draft` reads a draft and does not create one, for the same reason:
 * generating a form writes a record and an audit row, and a figure appearing on
 * a form should be traceable to a person who asked for it.
 */

export const NATIVE_TOOLS: Anthropic.Tool[] = [
  {
    name: "period_status",
    description:
      "Where the preparation stands for a filing period: the period itself, how many " +
      "documents were collected, read, categorised and matched, how many items are open " +
      "by severity, which sources were swept, which draft forms exist and whether a " +
      "package has been assembled. A source that was not swept reports available:false — " +
      "that is an absent connector, NOT a source with nothing in it. Deliberately carries " +
      "no money figures: gross receipts, expenses and net profit are defined once, on the " +
      "Schedule C draft, with the adjustments that produced them. Use get_form_draft.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
      },
    },
  },
  {
    name: "list_documents",
    description:
      "The collected documents for a period, each with what was read off it (vendor, " +
      "dates, totals, currency), the category it was put in, whether a person overrode " +
      "that category, whether it matched a ledger entry, and the open items against it. " +
      "A document with no extraction has not been read yet, which is not the same as a " +
      "document with nothing on it.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        source: {
          type: "string",
          enum: ["drive", "gmail", "upload", "fixture"],
          description: "Filter to one collection source.",
        },
        categoryId: { type: "string", description: "Filter to one tax category." },
        flaggedOnly: { type: "boolean", description: "Only documents with an open item." },
        limit: { type: "number", description: "Default 60." },
      },
    },
  },
  {
    name: "get_document",
    description:
      "One document in full: the file record, the extraction with its line items and its " +
      "confidence, the classification with its rationale and runners-up, the ledger match " +
      "if there is one, and every exception raised against it.",
    input_schema: {
      type: "object",
      properties: { docId: { type: "string" } },
      required: ["docId"],
    },
  },
  {
    name: "search_documents",
    description:
      "Find documents by free text. Matches the filename, the vendor, the invoice number, " +
      "the payment reference, the extraction notes, the line-item descriptions and the " +
      "category name. Use this before guessing which document someone means.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        periodId: { type: "string", description: "Defaults to the active period." },
        limit: { type: "number", description: "Default 25." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_categories",
    description:
      "The firm's chart of tax categories: id, name, what it does to the return, the " +
      "Schedule C line it maps to, what belongs in it, the fraction that reaches the form " +
      "line where that is under 100 per cent, and whether the category is one that always " +
      "goes to a human and why. Read this before explaining why a figure was adjusted or " +
      "why a document was flagged.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "category_totals",
    description:
      "Recorded and deductible totals per category for a period, with a document count. " +
      "'recorded' is what the documents add up to; 'deductible' is what reaches the return " +
      "after the statutory fraction — they differ for meals, and everything capitalised or " +
      "non-deductible has a deductible total of zero. Documents in a currency other than " +
      "the period's are excluded and flagged rather than converted.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
      },
    },
  },
  {
    name: "list_exceptions",
    description:
      "The open items: what was flagged, why, with the actual figures and filenames, and " +
      "the suggested action. Filter by status, kind, severity or document. A 'backdated-" +
      "document' finding is the one to escalate to the tax manager immediately. Resolving " +
      "any of these is a human action in the console — this tool only reads them.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        status: { type: "string", enum: ["open", "resolved", "accepted"] },
        kind: { type: "string", description: "One ExceptionKind, e.g. backdated-document." },
        severity: { type: "string", enum: ["high", "medium", "low"] },
        docId: { type: "string" },
        limit: { type: "number", description: "Default 60." },
      },
    },
  },
  {
    name: "reconciliation",
    description:
      "Documents against ledger entries. Returns the counts and three lists: pairs that " +
      "matched (with the amount difference where the two disagree), documents with no " +
      "ledger entry, and ledger entries with no supporting document. A ledger entry with " +
      "no document is a deduction claimed with nothing behind it.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        limit: { type: "number", description: "Rows per list. Default 40." },
      },
    },
  },
  {
    name: "list_ledger",
    description:
      "The accounting lines imported for a period: date, description, counterparty, " +
      "amount, account and reference. This app never writes to the ledger; it is read-only " +
      "fact here.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        query: { type: "string", description: "Substring on description, counterparty or ref." },
        limit: { type: "number", description: "Default 60." },
      },
    },
  },
  {
    name: "get_form_draft",
    description:
      "A draft form as it stands, with every line, both the recorded and the on-the-line " +
      "amount, the note saying why they differ, the open items against each line, and the " +
      "rendered markdown. Forms: schedule-c, 1099-nec-summary, 1040-es-worksheet. Every " +
      "one is a draft and nothing has been filed. This reads a draft; it does not generate " +
      "one — regenerating is done from the console.",
    input_schema: {
      type: "object",
      properties: {
        formId: {
          type: "string",
          enum: ["schedule-c", "1099-nec-summary", "1040-es-worksheet"],
        },
        periodId: { type: "string", description: "Defaults to the active period." },
      },
      required: ["formId"],
    },
  },
];

export function isNativeTool(name: string): boolean {
  return NATIVE_TOOLS.some((tool) => tool.name === name);
}

/**
 * The one sentence every refusal ends with.
 *
 * A refusal that says only "I cannot do that" leaves the operator with a dead
 * end. Naming the route a person takes turns a blocked tool call into a handover
 * rather than a failure.
 */
const HUMAN_ROUTE =
  "Resolving or accepting an open item, overriding a category, importing or clearing the " +
  "ledger, regenerating a form, assembling a package and handing one off are actions a person " +
  "takes in the DO-09 console. Each is behind a dialog that states the consequence and requires " +
  "a typed note, and the note lands in the audit trail. Say what you would do and why, and let " +
  "the operator decide.";

/** Dispatch one native tool call and return the JSON the model will read. */
export async function runNativeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { actor: string },
): Promise<string> {
  try {
    switch (name) {
      case "period_status":
        return json(await periodStatus(await resolvePeriod(input)));

      case "list_documents":
        return json(await documentList(input));

      case "get_document":
        return json(await oneDocument(String(input.docId ?? "")));

      case "search_documents":
        return json(await search(input));

      case "list_categories":
        /**
         * Sent whole rather than filtered. The traps are the useful part — the
         * 50 per cent on meals, the always-review reasons — and a model that
         * has only seen the names will explain a flag it cannot see the cause
         * of.
         */
        return json(
          CATEGORIES.map((category) => ({
            id: category.id,
            name: category.name,
            kind: category.kind,
            formLine: category.formLine,
            description: category.description,
            reachesTheLineAt:
              category.deductiblePct === undefined
                ? "100%"
                : `${Math.round(category.deductiblePct * 100)}%`,
            alwaysReview: Boolean(category.alwaysReview),
            reviewReason: category.reviewReason,
          })),
        );

      case "category_totals":
        return json(await categoryTotals(await resolvePeriod(input)));

      case "list_exceptions":
        return json(await exceptionList(input));

      case "reconciliation":
        return json(await reconciliation(input));

      case "list_ledger":
        return json(await ledgerList(input));

      case "get_form_draft":
        return json(await formDraft(input));

      default:
        /**
         * Fail closed on a name that does not exist. A model can hallucinate a
         * plausible tool — `resolve_exception` is the obvious one — and the
         * answer to it must be a refusal that names the human route, not an
         * error the model reads as a transient fault worth retrying.
         */
        return json({
          refused: `There is no ${name} tool. This assistant reads and prepares; it does not change a record.`,
          humanRoute: HUMAN_ROUTE,
          /**
           * The actor is the identity this conversation is attributed to, not
           * an authority it carries. Saying so in the refusal stops the model
           * reading "I am acting as the preparer" as "I may act for them".
           */
          conversationAttributedTo: ctx.actor,
        });
    }
  } catch (error) {
    // A tool error is data the model should see and explain, not an exception
    // that aborts the turn and loses the rest of the conversation.
    return json({ error: error instanceof Error ? error.message : "Tool failed." });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Implementations
 * ────────────────────────────────────────────────────────────────────────── */

async function resolvePeriod(input: Record<string, unknown>): Promise<string> {
  const given = str(input.periodId);
  if (!given) return (await activePeriod()).id;
  const period = await getPeriod(given);
  if (!period) {
    throw new Error(
      `No filing period with id ${given}. Call period_status with no arguments to see the active one.`,
    );
  }
  return period.id;
}

async function periodStatus(periodId: string) {
  const [period, settings, views, ledger, matches, exceptions, forms, packages, sources] =
    await Promise.all([
      getPeriod(periodId),
      getSettings(),
      documentViews(periodId),
      listLedger(periodId),
      listMatches(periodId),
      listExceptions({ periodId }),
      listForms(periodId),
      listPackages(periodId),
      sourceBreakdown(periodId),
    ]);

  const open = exceptions.filter((exception) => exception.status === "open");

  return {
    period,
    modelConfigured: modelConfigured(),
    thresholds: {
      reviewConfidence: settings.reviewConfidence,
      capitalisationThreshold: settings.capitalisationThreshold,
      contractor1099Threshold: settings.contractor1099Threshold,
      recurrenceGapMonths: settings.recurrenceGapMonths,
    },
    counts: {
      documents: views.length,
      extracted: views.filter((v) => v.extraction?.status === "extracted").length,
      unreadable: views.filter((v) => v.extraction && v.extraction.status !== "extracted").length,
      pendingExtraction: views.filter((v) => !v.extraction).length,
      classified: views.filter((v) => v.classification).length,
      pendingClassification: views.filter((v) => v.extraction && !v.classification).length,
      needsReview: views.filter((v) => v.classification?.needsReview).length,
      ledgerEntries: ledger.length,
      matched: matches.filter((m) => m.kind === "matched").length,
      documentOnly: matches.filter((m) => m.kind === "document-only").length,
      ledgerOnly: matches.filter((m) => m.kind === "ledger-only").length,
    },
    exceptions: {
      open: open.length,
      high: open.filter((e) => e.severity === "high").length,
      medium: open.filter((e) => e.severity === "medium").length,
      low: open.filter((e) => e.severity === "low").length,
      byKind: open.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    /** Absent connector, not an empty result. Report an unavailable source as an outage. */
    sources,
    forms: forms.map((form) => ({
      formId: form.formId,
      formName: form.formName,
      status: form.status,
      generatedAt: form.generatedAt,
      openItems: form.openExceptionIds.length,
    })),
    formsNotYetDrafted: FORMS.filter(
      (form) => !forms.some((draft) => draft.formId === form.id),
    ).map((form) => form.id),
    latestPackageId: packages[0]?.id,
    money:
      "Not reported here. Gross receipts, total expenses and net profit are defined once, on " +
      "the Schedule C draft, together with the adjustments that produced them. Call " +
      "get_form_draft with formId schedule-c rather than adding up category totals.",
  };
}

/** The shape a document takes in every list this module returns. */
function compact(view: DocumentView) {
  const categoryId = view.classification ? effectiveCategoryId(view.classification) : undefined;
  return {
    docId: view.doc.id,
    filename: view.doc.filename,
    source: view.doc.source,
    sourceDetail: view.doc.sourceDetail,
    read: view.extraction ? view.extraction.status : "not read yet",
    readDetail: view.extraction?.statusDetail,
    vendor: view.extraction?.vendor,
    vendorTaxId: view.extraction?.vendorTaxId ? "on file" : "not on file",
    invoiceNumber: view.extraction?.invoiceNumber,
    issueDate: view.extraction?.issueDate,
    currency: view.extraction?.currency,
    total: view.extraction?.total,
    extractionConfidence: view.extraction?.confidence,
    categoryId,
    categorySetBy: view.classification?.overriddenCategoryId ? "a person" : "the model",
    categoryConfidence: view.classification?.confidence,
    needsReview: view.classification?.needsReview,
    reviewReason: view.classification?.reviewReason,
    match: view.match
      ? { kind: view.match.kind, score: view.match.score, amountDelta: view.match.amountDelta }
      : undefined,
    openItems: view.exceptions
      .filter((exception) => exception.status === "open")
      .map((exception) => ({
        id: exception.id,
        kind: exception.kind,
        severity: exception.severity,
        title: exception.title,
      })),
  };
}

async function documentList(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const source = str(input.source);
  const categoryId = str(input.categoryId);
  const limit = num(input.limit, 60);

  let views = await documentViews(periodId);
  if (source) views = views.filter((view) => view.doc.source === source);
  if (categoryId) {
    views = views.filter(
      (view) => view.classification && effectiveCategoryId(view.classification) === categoryId,
    );
  }
  if (input.flaggedOnly === true) {
    views = views.filter((view) => view.exceptions.some((e) => e.status === "open"));
  }

  return {
    periodId,
    total: views.length,
    /** Truncation is stated, never silent — a cut-off list read as a complete one is a wrong answer. */
    returned: Math.min(views.length, limit),
    documents: views.slice(0, limit).map(compact),
    ...(views.length > limit
      ? { note: `${views.length - limit} more documents match. Narrow the filter to see them.` }
      : {}),
  };
}

async function oneDocument(docId: string) {
  if (!docId) return { error: "docId is required." };
  const doc = await listDocuments().then((all) => all.find((row) => row.id === docId));
  if (!doc) {
    return {
      error: `No document with id ${docId}. Use search_documents to find it by name or vendor.`,
    };
  }
  const view = (await documentViews(doc.periodId)).find((row) => row.doc.id === docId);
  if (!view) return { error: `Document ${docId} could not be joined to its period.` };

  return {
    document: view.doc,
    extraction: view.extraction ?? "Not read yet. This document has no figures on file.",
    classification: view.classification ?? "Not categorised. It is on no form line.",
    match: view.match ?? "No reconciliation row. It has been matched against nothing.",
    exceptions: view.exceptions,
  };
}

async function search(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const query = (str(input.query) ?? "").toLowerCase();
  const limit = num(input.limit, 25);
  if (!query) return { error: "query is required." };

  const views = await documentViews(periodId);
  const hits = views.filter((view) => haystack(view).includes(query));

  return {
    periodId,
    query,
    total: hits.length,
    documents: hits.slice(0, limit).map(compact),
    ...(hits.length > limit
      ? { note: `${hits.length - limit} more documents match "${query}".` }
      : {}),
    ...(hits.length === 0
      ? {
          note:
            `Nothing matched "${query}" among the ${views.length} documents collected for this ` +
            "period. That means no collected document matches, not that no such document exists — " +
            "one nobody sent is invisible here.",
        }
      : {}),
  };
}

/** Everything about a document a free-text search should reach. */
function haystack(view: DocumentView): string {
  const extraction = view.extraction;
  return [
    view.doc.filename,
    view.doc.sourceDetail,
    view.doc.sourceRef,
    extraction?.vendor,
    extraction?.vendorAddress,
    extraction?.invoiceNumber,
    extraction?.paymentMethod,
    extraction?.notes,
    extraction?.statusDetail,
    ...(extraction?.lineItems ?? []).map((item) => item.description),
    view.classification?.categoryId,
    view.classification?.overriddenCategoryId,
    view.classification?.rationale,
    ...view.exceptions.map((exception) => `${exception.title} ${exception.detail}`),
  ]
    .filter(Boolean)
    .join("   ")
    .toLowerCase();
}

async function exceptionList(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const limit = num(input.limit, 60);
  const severity = str(input.severity);

  let rows = await listExceptions({
    periodId,
    status: str(input.status) as never,
    kind: str(input.kind) as never,
    docId: str(input.docId),
  });
  if (severity) rows = rows.filter((exception) => exception.severity === severity);

  return {
    periodId,
    total: rows.length,
    exceptions: rows.slice(0, limit),
    resolution:
      "Closing any of these is a human action in the console. It requires a typed note, and the " +
      "note is what makes the closed item mean something six months from now.",
    ...(rows.length > limit ? { note: `${rows.length - limit} more items match.` } : {}),
  };
}

async function reconciliation(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const limit = num(input.limit, 40);
  const summary = await reconciliationSummary(periodId);

  return {
    periodId,
    counts: {
      matched: summary.matched.length,
      documentOnly: summary.documentOnly.length,
      ledgerOnly: summary.ledgerOnly.length,
      amountMismatches: summary.matched.filter((row) => row.match.amountDelta !== undefined).length,
    },
    matched: summary.matched.slice(0, limit).map((row) => ({
      score: row.match.score,
      reasons: row.match.reasons,
      amountDelta: row.match.amountDelta,
      document: row.doc
        ? { docId: row.doc.doc.id, filename: row.doc.doc.filename, total: row.doc.extraction?.total }
        : undefined,
      ledger: row.entry
        ? {
            id: row.entry.id,
            date: row.entry.date,
            counterparty: row.entry.counterparty,
            amount: row.entry.amount,
            account: row.entry.account,
          }
        : undefined,
    })),
    documentOnly: summary.documentOnly.slice(0, limit).map((row) => ({
      docId: row.doc.doc.id,
      filename: row.doc.doc.filename,
      vendor: row.doc.extraction?.vendor,
      issueDate: row.doc.extraction?.issueDate,
      total: row.doc.extraction?.total,
      reasons: row.match.reasons,
    })),
    ledgerOnly: summary.ledgerOnly.slice(0, limit).map((row) => ({
      ledgerEntryId: row.entry.id,
      date: row.entry.date,
      description: row.entry.description,
      counterparty: row.entry.counterparty,
      amount: row.entry.amount,
      account: row.entry.account,
      meaning: "A deduction claimed with no supporting document collected.",
    })),
  };
}

async function ledgerList(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const query = str(input.query)?.toLowerCase();
  const limit = num(input.limit, 60);

  let rows = await listLedger(periodId);
  if (query) {
    rows = rows.filter((entry) =>
      `${entry.description} ${entry.counterparty} ${entry.ref ?? ""}`.toLowerCase().includes(query),
    );
  }

  return {
    periodId,
    total: rows.length,
    entries: rows.slice(0, limit),
    readOnly: "This app never writes to the ledger. A disagreement with it is raised, not corrected.",
    ...(rows.length > limit ? { note: `${rows.length - limit} more entries match.` } : {}),
  };
}

async function formDraft(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const formId = str(input.formId) ?? "";
  const known = FORMS.some((form) => form.id === formId);
  if (!known) {
    return {
      error: `No form with id ${formId}.`,
      forms: FORMS,
    };
  }

  const draft = await getForm(periodId, formId);
  if (!draft) {
    return {
      formId,
      periodId,
      draft: null,
      /**
       * Not generated on demand. Drafting a form writes a record and an audit
       * row, and a figure on a tax form should trace back to a person who asked
       * for it rather than to a question somebody put to a chat panel.
       */
      note:
        `No ${formId} draft exists for this period yet. Drafting one is done from the console ` +
        `under Draft forms; this assistant reads drafts, it does not create them.`,
    };
  }

  return {
    draft,
    markdown: renderFormMarkdown(draft),
    reminder:
      `Every line above is a draft. ${draft.openExceptionIds.length} open ` +
      `${draft.openExceptionIds.length === 1 ? "item is" : "items are"} recorded against it, and ` +
      "nothing here has been filed.",
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Argument coercion
 * ────────────────────────────────────────────────────────────────────────── */

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A model sometimes sends a limit as a string, and NaN would slice nothing. */
function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
