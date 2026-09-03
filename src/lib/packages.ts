import "server-only";
import { record } from "./audit";
import { categoryName } from "./categories";
import { categoryTotals } from "./classify";
import { documentViews } from "./documents";
import { listExceptions } from "./exceptions";
import { generateAllForms, renderFormMarkdown } from "./forms";
import { getPeriod, getSettings, money, preparer, saveSettings } from "./settings";
import { mutate, newId, readStore } from "./store";
import { effectiveCategoryId } from "./types";
import type {
  DocumentView,
  FormDraft,
  PackageDocumentRow,
  ReviewPackage,
  TaxException,
} from "./types";

/**
 * The review package: everything the tax manager needs to decide, in one
 * document, assembled and never filed.
 *
 * Two rules shape this module.
 *
 * The first is that it computes nothing a model produced. Counts, category
 * totals and the document index are joins and sums over records a person can
 * open. The only drafted prose in the package is `summary`, which arrives from
 * the caller, is labelled as drafted on every rendering, and sits under the
 * open items rather than above them.
 *
 * The second is the order the markdown is written in. It leads with the open
 * items and puts the totals a long way down. A package that opens with a net
 * profit figure has told the reader the answer before it told them what is
 * unresolved, and everything after it reads as supporting detail rather than as
 * the reasons not to sign yet. Handing someone a tidy number and a list of
 * caveats they have to scroll to is how a draft gets treated as final.
 *
 * A note on what the package can carry: it renders only from what is stored in
 * it, so `renderPackageMarkdown(pkg, forms)` and the `markdown` written at
 * assembly time are the same text by construction. That is why
 * `PackageDocumentRow.flags` holds a severity and a title rather than an
 * exception id — an id in a handed-off file is a lookup the reader cannot do.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Reading
 * ────────────────────────────────────────────────────────────────────────── */

export async function listPackages(periodId: string): Promise<ReviewPackage[]> {
  const rows = await readStore<ReviewPackage[]>("packages", []);
  return rows
    .filter((pkg) => pkg.periodId === periodId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPackage(id: string): Promise<ReviewPackage | undefined> {
  const rows = await readStore<ReviewPackage[]>("packages", []);
  return rows.find((pkg) => pkg.id === id);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Assembly
 * ────────────────────────────────────────────────────────────────────────── */

const SEVERITY_LABEL = { high: "HIGH", medium: "MEDIUM", low: "LOW" } as const;
const SEVERITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * A flag is a severity and a title, in that order.
 *
 * The severity leads so the word carries the urgency rather than a colour a
 * printed package does not have, and the prefix is what lets the markdown sort
 * the open-items list worst-first without the exception records in hand.
 */
function flagFor(exception: TaxException): string {
  return `${SEVERITY_LABEL[exception.severity]} — ${exception.title}`;
}

function severityRank(flag: string): number {
  /** A state flag ("Unreadable", "Needs review") carries no severity word and sorts after the ones that do. */
  return SEVERITY_RANK[flag.split(" — ")[0]] ?? 3;
}

/** The worst severity on a row, for ordering the open-items list. */
function worstFlag(flags: string[]): number {
  return flags.reduce((rank, flag) => Math.min(rank, severityRank(flag)), 9);
}

/** One row per collected document, whatever state it is in. */
function indexRow(view: DocumentView, open: TaxException[]): PackageDocumentRow {
  const categoryId = view.classification ? effectiveCategoryId(view.classification) : undefined;
  const flags: string[] = [];

  /**
   * State flags come before exception flags, because "this was never read" is a
   * different kind of problem from "this was read and something is wrong with
   * it", and a reviewer sorting their afternoon needs to tell them apart.
   * Neither is ever left off to make the index look complete.
   */
  if (!view.extraction) flags.push("Not read yet");
  else if (view.extraction.status !== "extracted") flags.push("Unreadable");
  if (!view.classification) flags.push("Not categorised");
  else if (view.classification.needsReview) flags.push("Needs review");
  if (view.classification?.overriddenCategoryId) flags.push("Category set by a person");

  for (const exception of open) flags.push(flagFor(exception));

  return {
    docId: view.doc.id,
    filename: view.doc.filename,
    vendor: view.extraction?.vendor,
    issueDate: view.extraction?.issueDate,
    amount: view.extraction?.total,
    currency: view.extraction?.currency,
    categoryId,
    categoryName: categoryId ? categoryName(categoryId) : undefined,
    confidence: view.classification?.confidence,
    flags,
  };
}

/**
 * Build the package.
 *
 * The forms are regenerated first, always. A package that quotes a Schedule C
 * drafted before the last extraction is a package whose figures and whose
 * document index disagree, and the reader has no way to tell which half is
 * stale. Regenerating costs a few sums and removes the question.
 */
export async function assemble(
  periodId: string,
  actor: string,
  opts?: { summary?: string },
): Promise<ReviewPackage> {
  const period = await getPeriod(periodId);
  if (!period) {
    throw new Error(
      `No filing period with id ${periodId}. A package assembled against a period that does not ` +
        `exist would report a clean quarter with no documents in it.`,
    );
  }

  const forms = await generateAllForms(periodId, actor);

  const [views, totals, open] = await Promise.all([
    documentViews(periodId),
    categoryTotals(periodId),
    listExceptions({ periodId, status: "open" }),
  ]);

  const openByDoc = new Map<string, TaxException[]>();
  for (const exception of open) {
    for (const docId of exception.docIds) {
      openByDoc.set(docId, [...(openByDoc.get(docId) ?? []), exception]);
    }
  }

  const documentIndex = views
    .map((view) => indexRow(view, openByDoc.get(view.doc.id) ?? []))
    /**
     * Sorted by date, not by flag count. The open items are already listed at
     * the top of the package; this section is an index, and a reviewer looking
     * up an invoice knows roughly when it was dated, never how many flags it
     * collected. Undated documents sort last rather than first — an unread scan
     * with no date on it must not head the list of a quarter's paperwork.
     */
    .sort(
      (a, b) =>
        Number(!a.issueDate) - Number(!b.issueDate) ||
        (a.issueDate ?? "").localeCompare(b.issueDate ?? "") ||
        a.filename.localeCompare(b.filename),
    );

  const pkg: ReviewPackage = {
    id: newId("pkg"),
    periodId,
    createdAt: new Date().toISOString(),
    createdBy: actor,
    counts: {
      documents: views.length,
      extracted: views.filter((v) => v.extraction?.status === "extracted").length,
      unreadable: views.filter(
        (v) => v.extraction && v.extraction.status !== "extracted",
      ).length,
      classified: views.filter((v) => v.classification).length,
      needsReview: views.filter((v) => v.classification?.needsReview).length,
      openExceptions: open.length,
    },
    categoryTotals: totals,
    documentIndex,
    formDraftIds: forms.map((form) => form.id),
    openExceptionIds: open.map((exception) => exception.id),
    ...(opts?.summary?.trim() ? { summary: opts.summary.trim() } : {}),
  };

  pkg.markdown = renderPackageMarkdown(pkg, forms);

  await mutate<ReviewPackage[], ReviewPackage>("packages", [], (rows) => ({
    next: [pkg, ...rows].slice(0, 200),
    result: pkg,
  }));

  /**
   * A period that has already been handed off is not walked back to "packaged"
   * by assembling a fresh package. The handoff happened; a later package does
   * not un-happen it, and a status that flickers backwards is a status nobody
   * can act on. The audit row below is what says a package was cut after the
   * handoff, which is the fact worth being able to find.
   */
  if (period.status === "open") {
    const settings = await getSettings();
    await saveSettings({
      periods: settings.periods.map((p) =>
        p.id === periodId ? { ...p, status: "packaged" as const } : p,
      ),
    });
  }

  await record({
    actor,
    action: "package.assemble",
    subject: pkg.id,
    result: "ok",
    periodId,
    detail:
      `Assembled ${pkg.id} for ${period.label}: ${pkg.counts.documents} documents, ` +
      `${pkg.counts.extracted} read, ${pkg.counts.unreadable} unreadable, ` +
      `${pkg.counts.classified} categorised, ${pkg.counts.openExceptions} open ` +
      `${pkg.counts.openExceptions === 1 ? "item" : "items"}, ${forms.length} draft forms. ` +
      `Nothing filed and nothing sent` +
      (period.status === "handed-off"
        ? `; the period was already handed off, so its status is unchanged.`
        : `.`),
  });

  return pkg;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rendering
 * ────────────────────────────────────────────────────────────────────────── */

export function renderPackageMarkdown(pkg: ReviewPackage, forms: FormDraft[]): string {
  const currency = currencyOf(pkg);
  const out: string[] = [];

  /**
   * The heading names the period and not the entity, because the package holds
   * no entity field and reading one from live settings would let a rename next
   * year rewrite the header of a package that was handed off this one. What a
   * period was prepared under is a fact about that period; the operator puts
   * the entity in the covering message.
   */
  out.push(`# Review package`);
  out.push("");
  out.push(`Period \`${pkg.periodId}\`. Package \`${pkg.id}\`.`);
  out.push("");
  out.push(
    "**DRAFT. Nothing in this package has been filed, submitted or signed.** It was prepared by " +
      "DO-09 from the documents indexed below and is for review by a tax professional.",
  );
  out.push("");

  /* ── Open items first. Always. ─────────────────────────────────────── */
  out.push(`## Open items — ${pkg.counts.openExceptions} to read before anything else`);
  out.push("");

  const flagged = pkg.documentIndex
    .filter((row) => row.flags.length)
    .sort(
      (a, b) =>
        worstFlag(a.flags) - worstFlag(b.flags) ||
        (a.issueDate ?? "").localeCompare(b.issueDate ?? "") ||
        a.filename.localeCompare(b.filename),
    );

  if (pkg.counts.openExceptions === 0 && flagged.length === 0) {
    out.push(
      "Nothing was flagged. That is a statement about what the checks found in what was " +
        "collected, not a statement that the quarter is complete — a document nobody sent " +
        "raises no exception.",
    );
  } else {
    out.push(
      `${pkg.counts.openExceptions} open ${pkg.counts.openExceptions === 1 ? "item" : "items"} ` +
        `across ${flagged.length} ${flagged.length === 1 ? "document" : "documents"}. Each is ` +
        "listed with the document it was raised against; the full detail, the figures and the " +
        "suggested action for every one of them are in the console's Exceptions panel.",
    );
    out.push("");
    for (const row of flagged) {
      const facts = [
        row.vendor,
        row.issueDate,
        row.amount === undefined ? undefined : money(row.amount, row.currency ?? currency),
      ].filter(Boolean);
      out.push(`- **${row.filename}**${facts.length ? ` — ${facts.join(", ")}` : ""}`);
      for (const flag of row.flags) out.push(`  - ${flag}`);
    }
    out.push("");

  }

  /* ── The drafted paragraph, marked as drafted. ─────────────────────── */
  if (pkg.summary) {
    out.push("## Preparer's summary");
    out.push("");
    out.push("_Drafted by DO-09 from the figures below. Not reviewed, and not advice._");
    out.push("");
    out.push(`> ${pkg.summary.replace(/\n/g, "\n> ")}`);
    out.push("");
  }

  /* ── What it is not. ───────────────────────────────────────────────── */
  out.push("## What this package is not");
  out.push("");
  out.push("- It is not a filing. No return, form or 1099 has been submitted to any authority.");
  out.push(
    "- It is not advice. Where a figure depended on a judgement — capitalise or expense, " +
      "business-use fraction, what counts as personal — the document was routed to a person " +
      "rather than decided here.",
  );
  out.push(
    "- It is not a corrected set of books. Nothing in this app edits an accounting record or adjusts " +
      "an amount to make two figures agree; a disagreement is raised as an open item and left " +
      "standing.",
  );
  out.push(
    "- It is not complete by virtue of being assembled. It covers the documents that were " +
      "collected, and says so below.",
  );
  out.push("");

  /* ── Coverage. ─────────────────────────────────────────────────────── */
  out.push("## Coverage");
  out.push("");
  out.push("| | Count |");
  out.push("| --- | ---: |");
  out.push(`| Documents collected | ${pkg.counts.documents} |`);
  out.push(`| Read | ${pkg.counts.extracted} |`);
  out.push(`| Unreadable or failed | ${pkg.counts.unreadable} |`);
  out.push(`| Categorised | ${pkg.counts.classified} |`);
  out.push(`| Categorised but flagged for review | ${pkg.counts.needsReview} |`);
  out.push(`| Open items | ${pkg.counts.openExceptions} |`);
  out.push("");
  if (pkg.counts.documents > pkg.counts.classified) {
    out.push(
      `${pkg.counts.documents - pkg.counts.classified} collected ${
        pkg.counts.documents - pkg.counts.classified === 1 ? "document is" : "documents are"
      } not on any category total or form line below. They are not zero and they are not absent — ` +
        "they have not been placed.",
    );
    out.push("");
  }

  /* ── Totals, well below the open items. ────────────────────────────── */
  out.push("## Category totals");
  out.push("");
  if (pkg.categoryTotals.length === 0) {
    out.push("No documents have been categorised, so there are no totals to show.");
  } else {
    out.push("| Category | Kind | Docs | Recorded | Reaches the return |");
    out.push("| --- | --- | ---: | ---: | ---: |");
    for (const total of pkg.categoryTotals) {
      out.push(
        `| ${cell(total.name)} | ${total.kind} | ${total.docCount} | ${money(
          total.recorded,
          currency,
        )} | ${money(total.deductible, currency)} |`,
      );
    }
    out.push("");
    out.push(
      "Where the two figures differ, a statutory limit or a capitalisation rule moved the " +
        "number, not a correction to a document. The draft forms name each one.",
    );
  }
  out.push("");

  /* ── The drafts themselves. ────────────────────────────────────────── */
  out.push("## Draft forms");
  out.push("");
  if (forms.length === 0) {
    out.push("No draft forms were attached to this package.");
    out.push("");
  } else {
    for (const form of forms) {
      out.push(renderFormMarkdown(form));
      out.push("");
    }
  }

  /* ── The index. ────────────────────────────────────────────────────── */
  out.push("## Document index");
  out.push("");
  if (pkg.documentIndex.length === 0) {
    out.push("No documents were collected for this period.");
  } else {
    out.push("| Document | Vendor | Date | Amount | Category | Confidence | Flags |");
    out.push("| --- | --- | --- | ---: | --- | ---: | --- |");
    for (const row of pkg.documentIndex) {
      out.push(
        `| ${cell(row.filename)} | ${cell(row.vendor ?? "—")} | ${row.issueDate ?? "—"} | ${
          row.amount === undefined ? "—" : money(row.amount, row.currency ?? currency)
        } | ${cell(row.categoryName ?? "—")} | ${
          row.confidence === undefined ? "—" : row.confidence.toFixed(2)
        } | ${cell(row.flags.join("; ") || "—")} |`,
      );
    }
  }
  out.push("");

  out.push(
    `_Assembled ${pkg.createdAt} by ${pkg.createdBy}. Package ${pkg.id}, period ${pkg.periodId}. ` +
      `Nothing has been filed._`,
  );

  return out.join("\n");
}

/** The reporting currency, taken from the documents where the totals are empty. */
function currencyOf(pkg: ReviewPackage): string {
  return pkg.documentIndex.find((row) => row.currency)?.currency ?? "USD";
}

/** Pipes and newlines inside a cell would break the table apart. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Handoff
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Record that the package was handed to a named person.
 *
 * It sends nothing. There is no mail connector in this build, and a function
 * called `handOff` that quietly did nothing at all would leave an audit trail
 * saying a package was delivered when it was not. So this records the intent,
 * marks the period, and returns the package with its markdown for the operator
 * to send themselves — the trail then says what actually happened.
 *
 * It also does not mark anything final. The period moves to `handed-off`, which
 * describes where the paperwork went; every form in it is still a draft, and
 * the reviewer is free to send it back.
 */
export async function handOff(input: {
  packageId: string;
  actor: string;
  to: string;
  note?: string;
}): Promise<ReviewPackage> {
  const pkg = await getPackage(input.packageId);
  if (!pkg) {
    throw new Error(`No package with id ${input.packageId}.`);
  }

  const to = input.to.trim().toLowerCase();
  if (!to) {
    throw new Error(
      "A handoff needs a named recipient. Recording that a package went to nobody in particular " +
        "is the same as not recording it.",
    );
  }
  if (to === preparer().trim().toLowerCase()) {
    /**
     * The preparer is this app's own identity. Handing the package back to it
     * would put a review in the audit trail that no person ever read, which is
     * the failure the whole product exists to prevent.
     */
    throw new Error(
      `${to} is the address this app prepares under. A package handed to the preparer has not ` +
        `been reviewed by anyone — send it to the tax manager.`,
    );
  }

  const period = await getPeriod(pkg.periodId);
  if (!period) {
    throw new Error(`No filing period with id ${pkg.periodId}.`);
  }

  const settings = await getSettings();
  const handedOffAt = new Date().toISOString();
  await saveSettings({
    periods: settings.periods.map((p) =>
      p.id === pkg.periodId
        ? { ...p, status: "handed-off" as const, handedOffAt, handedOffTo: to }
        : p,
    ),
  });

  const note = input.note?.trim();
  await record({
    actor: input.actor,
    action: "package.handoff",
    subject: pkg.id,
    result: "ok",
    periodId: pkg.periodId,
    detail:
      `Package ${pkg.id} for ${period.label} handed to ${to} with ` +
      `${pkg.counts.openExceptions} open ${pkg.counts.openExceptions === 1 ? "item" : "items"} ` +
      `still on it and ${pkg.formDraftIds.length} forms, all draft. No mail was sent — this ` +
      `build has no connector, so the markdown was returned for the operator to send. ` +
      /**
       * The note is optional in this signature and required by the route that
       * calls it. Saying so in the row is deliberate: a handoff with no reason
       * recorded should be visible as one, not indistinguishable from a handoff
       * whose reason was never asked for.
       */
      (note ? `Note: ${note}` : "No note was given with this handoff."),
  });

  return pkg;
}
