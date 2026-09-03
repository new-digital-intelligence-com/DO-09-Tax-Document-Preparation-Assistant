import { consentUrl, driveEnv, driveStatus } from "@/lib/drive";

export const runtime = "nodejs";

/**
 * Send the operator to Google to grant access, once.
 *
 * A redirect rather than a printed URL: the whole point of doing this in the
 * app is that nobody has to copy a code between a terminal and a browser.
 */
export async function GET() {
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
