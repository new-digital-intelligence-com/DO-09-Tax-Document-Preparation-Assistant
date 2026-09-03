import { detect } from "@/lib/exceptions";
import { activePeriod, preparer } from "@/lib/settings";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Recompute the findings.
 *
 * Safe to run whenever, which is the whole design: what survives a re-run is a
 * reviewer's status and note; what is refreshed is the wording, the figures and
 * the severity. Detection that reopened everything a person had worked through
 * would be run once and then never again.
 */
export async function POST() {
  try {
    const period = await activePeriod();
    return ok(await detect(period.id, preparer()));
  } catch (error) {
    return failed(error, "Detection failed.");
  }
}
