import { getPackage, listPackages, renderPackageMarkdown } from "@/lib/packages";
import { packageFilename, renderPackagePdf } from "@/lib/package-pdf";
import { listForms } from "@/lib/forms";
import { getPeriod, activePeriod, preparer } from "@/lib/settings";
import { record } from "@/lib/audit";
import { bad, failed } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The review package as a PDF.
 *
 * A GET rather than a POST because it is a document, not an action: it should
 * be linkable, openable in a new tab, and re-fetchable without a warning about
 * resubmitting anything. Nothing is written by producing one — the download is
 * recorded on the trail, but the package itself is untouched.
 *
 * `?id=` picks a specific package; without it the newest is used, which is
 * what the console's button wants.
 */
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    const period = await activePeriod();

    const pkg = id ? await getPackage(id) : (await listPackages(period.id))[0];
    if (!pkg) {
      return bad(
        id
          ? `No package with id ${id}.`
          : "No package has been assembled for this period yet. Assemble one first.",
        404,
      );
    }

    // A package carries its own period id: downloading an older quarter's pack
    // must render it under the period it was prepared for, not whichever one
    // happens to be active now.
    const its = (await getPeriod(pkg.periodId)) ?? period;
    const forms = await listForms(pkg.periodId);

    const pdf = renderPackagePdf({
      pkg,
      period: its,
      markdown: pkg.markdown ?? renderPackageMarkdown(pkg, forms),
      preparedBy: pkg.createdBy || preparer(),
    });

    await record({
      actor: preparer(),
      action: "package.downloaded",
      subject: pkg.id,
      result: "ok",
      periodId: pkg.periodId,
      detail:
        `The ${its.label} package was downloaded as a PDF (${pdf.length} bytes). It is marked ` +
        `DRAFT on every page and nothing was filed or sent.`,
    });

    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        // `inline` so a click opens it in the browser's viewer, where somebody
        // can actually read it before deciding to send it on. The filename is
        // still honoured by every browser's save button.
        "content-disposition": `inline; filename="${packageFilename(its)}"`,
        "content-length": String(pdf.length),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return failed(error, "The package PDF could not be produced.");
  }
}
