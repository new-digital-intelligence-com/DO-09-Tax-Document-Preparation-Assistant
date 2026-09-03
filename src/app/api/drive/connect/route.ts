import { consentUrl, driveEnv, driveStatus } from "@/lib/drive";
import { redirectMismatch } from "@/lib/redirect-check";

export const runtime = "nodejs";

/**
 * Send the operator to Google to grant access, once.
 *
 * A redirect rather than a printed URL: the whole point of doing this in the
 * app is that nobody has to copy a code between a terminal and a browser.
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

  const env = driveEnv();
  if (!env.clientId || !env.clientSecret) {
    return new Response("The Drive client id and secret are not both set.", { status: 503 });
  }

  return Response.redirect(consentUrl(), 302);
}
