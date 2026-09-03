import { listAudit } from "@/lib/audit";
import { activePeriod } from "@/lib/settings";
import { failed, num, ok } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const period = await activePeriod();
    const query = new URL(request.url).searchParams;

    return ok(
      await listAudit({
        periodId: query.get("periodId") ?? period.id,
        docId: query.get("docId") ?? undefined,
        exceptionId: query.get("exceptionId") ?? undefined,
        action: query.get("action") ?? undefined,
        actor: query.get("actor") ?? undefined,
        limit: num(query.get("limit")) ?? 200,
      }),
    );
  } catch (error) {
    return failed(error, "The audit trail could not be read.");
  }
}
