import { categoryTotals, classifyPending, listClassifications } from "@/lib/classify";
import { activePeriod, preparer } from "@/lib/settings";
import { modelConfigured } from "@/lib/anthropic";
import { bad, body, failed, num, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  try {
    const period = await activePeriod();
    const [classifications, totals] = await Promise.all([
      listClassifications(period.id),
      categoryTotals(period.id),
    ]);
    return ok({ currency: period.currency, classifications, totals });
  } catch (error) {
    return failed(error, "The categorisations could not be read.");
  }
}

export async function POST(request: Request) {
  if (!modelConfigured()) {
    return bad("ANTHROPIC_API_KEY is not set, so nothing can be categorised.", 503);
  }
  try {
    const payload = await body(request).catch(() => ({}) as Record<string, unknown>);
    const period = await activePeriod();
    return ok(await classifyPending(period.id, preparer(), num(payload.limit)));
  } catch (error) {
    return failed(error, "The categorisation run failed.");
  }
}
