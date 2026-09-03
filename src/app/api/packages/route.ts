import { assemble, getPackage, listPackages, renderPackageMarkdown } from "@/lib/packages";
import { listForms } from "@/lib/forms";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request) {
  try {
    const period = await activePeriod();
    const id = new URL(request.url).searchParams.get("id");

    if (id) {
      const pkg = await getPackage(id);
      if (!pkg) return bad(`No package with id ${id}.`, 404);
      const forms = await listForms(pkg.periodId);
      return ok({ package: pkg, markdown: renderPackageMarkdown(pkg, forms) });
    }

    return ok({ period, packages: await listPackages(period.id) });
  } catch (error) {
    return failed(error, "The packages could not be read.");
  }
}

/**
 * Assemble the handoff.
 *
 * The drafts are regenerated first, so a package can never carry a form that
 * predates the categorisation behind it. A stale figure in a pack somebody is
 * about to file from is worse than no pack.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request).catch(() => ({}) as Record<string, unknown>);
    const period = await activePeriod();
    const pkg = await assemble(period.id, preparer(), { summary: str(payload.summary) });
    const forms = await listForms(period.id);
    return ok({ package: pkg, markdown: renderPackageMarkdown(pkg, forms) });
  } catch (error) {
    return failed(error, "The package could not be assembled.");
  }
}
