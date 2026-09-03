import { getPackage, handOff } from "@/lib/packages";
import { sendMail } from "@/lib/gmail";
import { accountConnection } from "@/lib/google-account";
import { record } from "@/lib/audit";
import { activePeriod, preparer, taxManager } from "@/lib/settings";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Email the review package to the tax manager, from the preparer's own address.
 *
 * From their address rather than the app's, because a review package arriving
 * from a no-reply robot is one the recipient cannot reply to and has no reason
 * to trust. Gmail sets the From header from the authenticated account itself,
 * so there is no way for this to claim to be anyone else.
 *
 * Sending and recording the handoff are the same act here, deliberately. A
 * package emailed without the handoff recorded leaves the register saying
 * nobody has it; a handoff recorded without the mail going out leaves a person
 * believing a review is under way that nobody was told about. So the mail goes
 * first — it is the part that can fail for reasons outside this app — and the
 * record is written only once it has actually gone.
 *
 * Nothing here files anything. The body says so, every time, because the one
 * misreading that matters is a recipient thinking the quarter is done.
 */
export async function POST(request: Request) {
  try {
    const connection = await accountConnection();
    if (!connection.connected || !connection.can.gmailSend) {
      return bad(
        connection.connected
          ? "This workspace's Google account is connected but was not granted permission to send " +
            "mail. Reconnect it and approve sending."
          : "No Google account is connected to this workspace, so there is no address to send " +
            "from. Connect one first.",
        409,
      );
    }

    const payload = await body(request);
    const packageId = str(payload.packageId);
    if (!packageId) return bad("Send the packageId.");

    const pkg = await getPackage(packageId);
    if (!pkg) return bad(`No package with id ${packageId}.`, 404);

    const to = str(payload.to) ?? taxManager();
    if (!to || to.includes("example.invalid")) {
      return bad(
        "No recipient. Set TAX_MANAGER_EMAIL, or send an explicit `to` — a package with nobody " +
          "named is a package nobody is waiting for.",
      );
    }
    if (to.trim().toLowerCase() === preparer().trim().toLowerCase()) {
      return bad(
        "The package cannot be sent to the address that prepared it. A second person reviewing it " +
          "before filing is the whole point of the handoff.",
      );
    }

    const period = await activePeriod();
    const note = str(payload.note);

    const subject = `DRAFT for review — ${period.label} ${period.entity}`;
    const intro = [
      `${period.label} for ${period.entity} is assembled and ready for your review.`,
      "",
      `Everything in this package is a DRAFT. Nothing has been filed, submitted or signed, and`,
      `nothing in this app can do any of those things.`,
      "",
      `${pkg.counts.documents} documents collected · ${pkg.counts.extracted} read · ` +
        `${pkg.counts.needsReview} need a decision · ${pkg.counts.openExceptions} items still open.`,
      note ? `\nFrom ${preparer()}:\n${note}` : "",
      "",
      "The full package follows.",
      "",
      "----",
      "",
      pkg.markdown ?? "(The package has no rendered content — regenerate it from the console.)",
    ].join("\n");

    const sent = await sendMail({
      to,
      cc: str(payload.cc),
      subject,
      body: intro,
    });

    // Only now that it has actually gone.
    const handed = await handOff({ packageId, actor: preparer(), to, note });

    await record({
      actor: preparer(),
      action: "package.emailed",
      subject: pkg.id,
      result: "ok",
      periodId: pkg.periodId,
      detail:
        `The ${period.label} package was emailed to ${to}${payload.cc ? ` (cc ${str(payload.cc)})` : ""} ` +
        `from ${connection.email ?? "the connected account"} as Gmail message ${sent.id}. ` +
        `It is marked DRAFT throughout and nothing was filed.`,
    });

    return ok({
      sent: true,
      to,
      from: connection.email,
      messageId: sent.id,
      package: handed,
      note: `Sent to ${to} from ${connection.email ?? "your connected account"}, and the handoff is recorded.`,
    });
  } catch (error) {
    if (error instanceof Error && /No package|must be a JSON|handed to the preparer/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The package could not be sent.");
  }
}
