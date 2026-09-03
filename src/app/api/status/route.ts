import { activePeriod, preparerConfigured, taxManagerConfigured } from "@/lib/settings";
import { listDocuments, sourceBreakdown } from "@/lib/documents";
import { listExtractions } from "@/lib/extract";
import { categoryTotals, listClassifications } from "@/lib/classify";
import { listExceptions } from "@/lib/exceptions";
import { listForms } from "@/lib/forms";
import { listPackages } from "@/lib/packages";
import { modelConfigured } from "@/lib/anthropic";
import { failed, ok } from "@/lib/http";
import type { PrepStatus } from "@/lib/types";

export const runtime = "nodejs";

/**
 * What the console leads with.
 *
 * Every money figure is `null` rather than `0` when the step that would
 * produce it has not run. Nothing has been extracted yet and gross receipts of
 * `0` is a period with no income; `null` is a period nobody has read. The
 * console draws those differently and the difference matters.
 */
export async function GET() {
  try {
    const period = await activePeriod();
    const periodId = period.id;

    const [docs, extractions, classifications, exceptions, forms, packages, sources] =
      await Promise.all([
        listDocuments({ periodId }),
        listExtractions(periodId),
        listClassifications(periodId),
        listExceptions({ periodId }),
        listForms(periodId),
        listPackages(periodId),
        sourceBreakdown(periodId),
      ]);

    const extracted = extractions.filter((e) => e.status === "extracted").length;
    const unreadable = extractions.filter((e) => e.status !== "extracted").length;
    const open = exceptions.filter((e) => e.status === "open");

    const anyClassified = classifications.length > 0;
    const totals = anyClassified ? await categoryTotals(periodId) : [];
    const sum = (test: (kind: string) => boolean) =>
      totals.filter((t) => test(t.kind)).reduce((n, t) => n + t.recorded, 0);

    const status: PrepStatus = {
      period,
      modelConfigured: modelConfigured(),
      counts: {
        documents: docs.length,
        extracted,
        unreadable,
        pendingExtraction: docs.length - extractions.length,
        classified: classifications.length,
        pendingClassification: Math.max(0, extracted - classifications.length),
        needsReview: classifications.filter((c) => c.needsReview).length,
      },
      exceptions: {
        open: open.length,
        high: open.filter((e) => e.severity === "high").length,
        medium: open.filter((e) => e.severity === "medium").length,
        low: open.filter((e) => e.severity === "low").length,
      },
      money: {
        currency: period.currency,
        grossReceipts: anyClassified ? sum((k) => k === "income") : null,
        totalExpenses: anyClassified ? sum((k) => k === "expense" || k === "cogs") : null,
        deductibleExpenses: anyClassified
          ? totals
              .filter((t) => t.kind === "expense" || t.kind === "cogs")
              .reduce((n, t) => n + t.deductible, 0)
          : null,
        unclassified: anyClassified ? sum((k) => k === "non-deductible" || k === "asset") : null,
      },
      forms: forms.map((f) => ({
        formId: f.formId,
        formName: f.formName,
        generatedAt: f.generatedAt,
      })),
      latestPackageId: packages[0]?.id,
      sources,
    };

    return ok({
      ...status,
      preparerConfigured: preparerConfigured(),
      taxManagerConfigured: taxManagerConfigured(),
    });
  } catch (error) {
    return failed(error, "The period could not be read.");
  }
}
