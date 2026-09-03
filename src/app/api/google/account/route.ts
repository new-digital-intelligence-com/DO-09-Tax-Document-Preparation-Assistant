import { accountConnection, disconnectAccount } from "@/lib/google-account";
import { record } from "@/lib/audit";
import { preparer } from "@/lib/settings";
import { failed, ok } from "@/lib/http";

export const runtime = "nodejs";

/** Whether this workspace has somebody's Google account attached, and what it may do. */
export async function GET() {
  try {
    return ok(await accountConnection());
  } catch (error) {
    return failed(error, "The Google connection could not be read.");
  }
}

/**
 * Disconnect it.
 *
 * Revocation is asked of Google as well as forgotten here, so "disconnect"
 * means the app can no longer reach the account rather than merely that it has
 * stopped mentioning it.
 */
export async function DELETE() {
  try {
    const connection = await accountConnection();
    await disconnectAccount();
    await record({
      actor: preparer(),
      action: "google.disconnected",
      subject: connection.email ?? "google-account",
      result: "ok",
      detail:
        `The Google account ${connection.email ?? "(address unknown)"} was disconnected from this ` +
        `workspace and its access revoked. Imports from that Drive and mailbox are no longer possible.`,
    });
    return ok({ disconnected: true });
  } catch (error) {
    return failed(error, "The account could not be disconnected.");
  }
}
