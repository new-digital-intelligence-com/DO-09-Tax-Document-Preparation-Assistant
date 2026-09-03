import { reconcile, reconciliationSummary } from "@/lib/reconcile";
import { activePeriod, preparer } from "@/lib/settings";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const period = await activePeriod();
    return ok({ currency: period.currency, ...(await reconciliationSummary(period.id)) });
  } catch (error) {
    return failed(error, "The reconciliation could not be read.");
  }
}

/** Recompute the pairing. Deterministic, so it is safe to run at any time. */
export async function POST() {
  try {
    const period = await activePeriod();
    return ok(await reconcile(period.id, preparer()));
  } catch (error) {
    return failed(error, "The reconciliation failed.");
  }
}
