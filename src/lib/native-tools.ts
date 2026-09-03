import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { modelConfigured } from "./anthropic";
import { listAudit } from "./audit";
import { CATEGORIES, categoryName } from "./categories";
import { categoryTotals } from "./classify";
import { documentViews, listDocuments, sourceBreakdown } from "./documents";
import { listExceptions } from "./exceptions";
import { FORMS, getForm, listForms, renderFormMarkdown } from "./forms";
import { listPackages } from "./packages";
import { activePeriod, getPeriod, getSettings } from "./settings";
import { effectiveCategoryId } from "./types";
import type { DocumentView, ExceptionKind, TaxException } from "./types";

/**
 * The app's tools, and the whole of the agent's authority.
 *
 * What is in this list matters less than what is not. There is no
 * `resolve_exception`, no `override_category`, no `file_return`, no
 * no `assemble_package` and no `hand_off`. The agent can read
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
      "that category, and the open items against it. " +
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
      "confidence, the classification with its rationale and runners-up, " +
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
      "Find documents by free text. Matches on ANY word in the query, not the phrase, across " +
      "the filename, vendor, vendor address, tax id, invoice number, payment method, extraction " +
      "notes, every line-item description, the category name and the categorisation rationale. " +
      "Results come back best-match first, each with the words that actually hit. Use this " +
      "whenever someone asks whether they have something — a vendor, a subscription, a charge — " +
      "rather than saying you cannot check. Try a narrower single word before concluding that " +
      "nothing is there.",
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
      "the suggested action. Filter by status, kind, severity or document. Resolving any of " +
      "these is a human action in the console — this tool only reads them.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        status: { type: "string", enum: ["open", "resolved", "accepted"] },
        kind: { type: "string", description: "One ExceptionKind, e.g. total-mismatch." },
        severity: { type: "string", enum: ["high", "medium", "low"] },
        docId: { type: "string" },
        limit: { type: "number", description: "Default 60." },
      },
    },
  },
  {
    name: "list_audit",
    description:
      "The append-only trail: who did what, when, to which document or item, and what they " +
      "wrote as their reason. This is how to answer 'what happened to this document', 'why " +
      "is this figure different from last week' and 'who decided that'. `query` searches the text " +
      "of every entry, which is the ONLY way to find a document that has since been deleted — its " +
      "filename lives in the entry's wording, not in a field. Search here by filename before " +
      "telling anyone no record of something exists. Every entry is a record of something that " +
      "already happened; nothing here can be changed.",
    input_schema: {
      type: "object",
      properties: {
        periodId: { type: "string", description: "Defaults to the active period." },
        docId: { type: "string", description: "Everything that happened to one document." },
        query: {
          type: "string",
          description:
            "Free text across every entry's wording — a filename, a vendor, an amount. Use this " +
            "to trace a document that is no longer on the register.",
        },
        action: {
          type: "string",
          description:
            "Substring match on the action, e.g. 'document.' or 'exception.resolved' or 'delete'.",
        },
        actor: { type: "string", description: "Exact match on who did it." },
        limit: { type: "number", description: "Default 40, newest first." },
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
  "regenerating a form, assembling a package and handing one off are actions a person " +
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
        return json(await oneDocument(input));

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

      case "get_form_draft":
        return json(await formDraft(input));

      case "list_audit":
        return json(
          await listAudit({
            periodId: await resolvePeriod(input),
            docId: str(input.docId) || undefined,
            query: str(input.query) || undefined,
            action: str(input.action) || undefined,
            actor: str(input.actor) || undefined,
            limit: num(input.limit, 40),
          }),
        );

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
  const [period, settings, views, exceptions, forms, packages, sources] =
    await Promise.all([
      getPeriod(periodId),
      getSettings(),
      documentViews(periodId),
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
    returned: Math.min(views.length, limit),
    documents: views.slice(0, limit).map(compact),
  };
}

/** One document in full: what was read off it, where it was placed, its flags. */
async function oneDocument(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const docId = str(input.docId);
  if (!docId) return { error: "Send a docId. list_documents returns them." };

  const views = await documentViews(periodId);
  const view = views.find((row) => row.doc.id === docId);
  if (!view) {
    return { error: `No document ${docId} in ${periodId}.`, total: views.length };
  }

  return {
    ...compact(view),
    rationale: view.classification?.rationale,
    alternatives: view.classification?.alternatives,
    lineItems: view.extraction?.lineItems ?? [],
    notes: view.extraction?.notes,
    exceptions: view.exceptions.map((exception) => ({
      id: exception.id,
      kind: exception.kind,
      severity: exception.severity,
      status: exception.status,
      title: exception.title,
      detail: exception.detail,
      suggestedAction: exception.suggestedAction,
    })),
  };
}

/**
 * Free-text search across the corpus.
 *
 * Substring matching over the fields a person would actually name — filename,
 * vendor, invoice number, category. Not a ranked search: this is forty to a few
 * hundred documents, and a model asking for "AWS" wants every AWS document
 * rather than the best three.
 */
/**
 * Find documents by free text, matching on any word rather than the phrase.
 *
 * Matching the whole query as one substring is what a database does and it is
 * the wrong behaviour for something a model queries in natural language. Asked
 * "do I have an Anthropic subscription", a model sensibly searches for
 * "Anthropic subscription" — and a phrase match returns nothing, because no
 * field on the receipt contains those two words side by side. The vendor says
 * "Anthropic, PBC" and the line item says "Max plan". The document is right
 * there and the search reports an empty workspace, which is the worst answer
 * available: not "I could not find it" but a confident, wrong "you do not have
 * one".
 *
 * So the query is split into words and a document matches if any of them hits.
 * Results are then ordered by how many distinct words matched, which puts the
 * document that matched both "anthropic" and "subscription" above the one that
 * only matched "subscription". Short words are dropped — "a", "do", "my" match
 * everything and rank nothing.
 *
 * The fields searched are every field this tool's description promises,
 * including the line items and the extraction notes. They were promised and
 * not searched before, and a tool that quietly searches less than it claims
 * makes a model give up on documents it would have found by asking differently.
 */
async function search(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const query = (str(input.query) ?? "").trim().toLowerCase();
  if (!query) return { error: "Send a query." };

  const limit = num(input.limit, 40);
  const views = await documentViews(periodId);

  const terms = Array.from(new Set(query.split(/[^a-z0-9]+/i).filter((word) => word.length > 2)));
  // A query that is nothing but short words ("a/c", "VAT") still has to search
  // for something, so it falls back to the phrase it was given.
  const needles = terms.length > 0 ? terms : [query];

  const scored = views
    .map((view) => {
      const categoryId = view.classification ? effectiveCategoryId(view.classification) : "";
      const haystack = [
        view.doc.filename,
        view.doc.sourceDetail,
        view.extraction?.vendor,
        view.extraction?.invoiceNumber,
        view.extraction?.paymentMethod,
        view.extraction?.vendorAddress,
        view.extraction?.vendorTaxId,
        view.extraction?.notes,
        view.extraction?.currency,
        ...(view.extraction?.lineItems ?? []).map((item) => item.description),
        categoryId,
        categoryId ? categoryName(categoryId) : "",
        view.classification?.rationale,
      ]
        .filter(Boolean)
        .join(" \n ")
        .toLowerCase();

      const matched = needles.filter((needle) => haystack.includes(needle));
      return { view, matched };
    })
    .filter((row) => row.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length);

  return {
    periodId,
    query,
    searchedFor: needles,
    total: scored.length,
    returned: Math.min(scored.length, limit),
    /**
     * Which words actually hit, per document. A model that can see it matched
     * only on "subscription" knows to say "this looks like it, but the vendor
     * name did not match" rather than asserting it found what was asked for.
     */
    documents: scored.slice(0, limit).map((row) => ({
      ...compact(row.view),
      matchedTerms: row.matched,
    })),
  };
}

/** The flag list, filtered the way the console filters it. */
async function exceptionList(input: Record<string, unknown>) {
  const periodId = await resolvePeriod(input);
  const status = str(input.status) as TaxException["status"] | undefined;
  const kind = str(input.kind) as ExceptionKind | undefined;

  const all = await listExceptions({ periodId });
  const rows = all.filter((exception) => {
    if (status && exception.status !== status) return false;
    if (kind && exception.kind !== kind) return false;
    return true;
  });

  const open = all.filter((exception) => exception.status === "open");

  return {
    periodId,
    // Counts over the whole period, not the filtered slice: "2 open" because a
    // filter is on would read as a period with two problems.
    counts: {
      total: all.length,
      open: open.length,
      high: open.filter((exception) => exception.severity === "high").length,
      medium: open.filter((exception) => exception.severity === "medium").length,
      low: open.filter((exception) => exception.severity === "low").length,
    },
    returned: rows.length,
    exceptions: rows.map((exception) => ({
      id: exception.id,
      kind: exception.kind,
      severity: exception.severity,
      status: exception.status,
      title: exception.title,
      detail: exception.detail,
      suggestedAction: exception.suggestedAction,
      amount: exception.amount,
      currency: exception.currency,
      documents: exception.docIds,
      resolutionNote: exception.resolutionNote,
    })),
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
