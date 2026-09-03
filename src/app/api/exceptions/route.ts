import { listExceptions } from "@/lib/exceptions";
import { activePeriod } from "@/lib/settings";
import { failed, ok } from "@/lib/http";
import type { ExceptionKind, TaxException } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const period = await activePeriod();
    const query = new URL(request.url).searchParams;

    const exceptions = await listExceptions({
      periodId: period.id,
      status: (query.get("status") as TaxException["status"]) ?? undefined,
      kind: (query.get("kind") as ExceptionKind) ?? undefined,
      docId: query.get("docId") ?? undefined,
    });

    // Counts over the whole period, not the filtered slice: a screen showing
    // "2 open" because a filter is on is a screen that hides the other seven.
    const all = await listExceptions({ periodId: period.id });
    const open = all.filter((e) => e.status === "open");

    return ok({
      currency: period.currency,
      exceptions,
      counts: {
        total: all.length,
        open: open.length,
        resolved: all.filter((e) => e.status === "resolved").length,
        accepted: all.filter((e) => e.status === "accepted").length,
        high: open.filter((e) => e.severity === "high").length,
        medium: open.filter((e) => e.severity === "medium").length,
        low: open.filter((e) => e.severity === "low").length,
      },
    });
  } catch (error) {
    return failed(error, "The exceptions could not be read.");
  }
}
