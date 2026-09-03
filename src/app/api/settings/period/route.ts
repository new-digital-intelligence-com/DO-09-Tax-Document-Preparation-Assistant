import { activePeriod, savePeriod } from "@/lib/settings";
import { record } from "@/lib/audit";
import { preparer } from "@/lib/settings";
import { bad, body, failed, ok } from "@/lib/http";
import type { FilingPeriod } from "@/lib/types";

export const runtime = "nodejs";

/** The period as it stands, so the editor opens on what is actually set. */
export async function GET() {
  try {
    return ok({ period: await activePeriod() });
  } catch (error) {
    return failed(error, "The period could not be read.");
  }
}

/**
 * Rename or re-date the period.
 *
 * What it is called, who it is for and what it covers are all things this app
 * shipped a guess at and cannot know. The guess used to be fixed — a quarter
 * from a past year under a fixture company name — which meant anybody
 * preparing their own documents read a heading that was wrong about both.
 *
 * The change is written to the audit trail with the old and new values,
 * because the period label is printed on every draft form: a form found later
 * headed differently from the one somebody remembers is a discrepancy worth
 * being able to explain in one look.
 */
export async function PUT(request: Request) {
  try {
    const before = await activePeriod();
    const patch = (await body(request)) as Partial<FilingPeriod>;
    const after = await savePeriod(patch);

    const changes = (["label", "entity", "start", "end", "currency", "basis", "jurisdiction"] as const)
      .filter((key) => before[key] !== after[key])
      .map((key) => `${key}: ${before[key]} → ${after[key]}`);

    if (changes.length > 0) {
      await record({
        actor: preparer(),
        action: "period.updated",
        subject: after.id,
        result: "ok",
        periodId: after.id,
        detail: `The filing period was edited. ${changes.join("; ")}.`,
      });
    }

    return ok({ period: after, changed: changes });
  } catch (error) {
    if (error instanceof Error && /ends .* before it starts|must be a JSON/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The period could not be saved.");
  }
}
