import { requireActiveUser } from "@/lib/users";
import { accountConsentUrl } from "@/lib/google-account";
import { driveStatus } from "@/lib/drive";
import { redirectMismatch } from "@/lib/redirect-check";

export const runtime = "nodejs";

/**
 * Send the person using this workspace to approve access to their OWN account.
 *
 * Not the app's workspace connection — that is `/api/drive/connect` and it is
 * set up once by whoever runs the app. This one is per person: whoever is in
 * this workspace approves their own Drive and their own mailbox, and only
 * their own is ever read.
 *
 * The active user is resolved here rather than taken from the query string. A
 * user id that arrived as a parameter would let anyone who can reach this URL
 * start an authorisation that lands in somebody else's workspace.
 */
export async function GET(request: Request) {
  // Checked before redirecting, so a misconfiguration is reported here
  // rather than as an opaque Google error page.
  const mismatch = redirectMismatch(request);
  if (mismatch) return new Response(mismatch, { status: 503 });

  const status = driveStatus();
  if (status.state === "unconfigured") {
    return new Response(status.detail, { status: 503 });
  }

  const user = await requireActiveUser();
  return Response.redirect(accountConsentUrl(user.id), 302);
}
