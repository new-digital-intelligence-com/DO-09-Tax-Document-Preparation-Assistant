import { CATEGORIES } from "@/lib/categories";
import { activePeriod } from "@/lib/settings";
import { categoryTotals } from "@/lib/classify";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";

/** The chart, and what the period has landed in each of its categories. */
export async function GET() {
  try {
    const period = await activePeriod();
    const totals = await categoryTotals(period.id);
    const byId = new Map(totals.map((t) => [t.categoryId, t]));

    return ok({
      currency: period.currency,
      categories: CATEGORIES.map((category) => ({
        ...category,
        recorded: byId.get(category.id)?.recorded ?? 0,
        deductible: byId.get(category.id)?.deductible ?? 0,
        docCount: byId.get(category.id)?.docCount ?? 0,
      })),
    });
  } catch (error) {
    return failed(error, "The category chart could not be read.");
  }
}
