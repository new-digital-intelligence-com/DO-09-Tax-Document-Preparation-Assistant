import "server-only";
import { driveEnv } from "./drive";

/**
 * Catch a redirect-URI mismatch before Google does.
 *
 * OAuth requires the `redirect_uri` to match a value registered on the client
 * exactly — scheme, host, port and path. When it does not, Google answers with
 * `Error 400: redirect_uri_mismatch` on a page that does not say what the two
 * values were, and the person setting the app up has to guess which of them is
 * wrong.
 *
 * The commonest way to get there is deploying: `GOOGLE_REDIRECT_URI` defaults
 * to `http://localhost:3000/api/drive/callback`, which is right on a laptop and
 * useless on a hosted URL. Nothing about the build catches it, and the app
 * looks completely fine until somebody presses Connect.
 *
 * So the request's own origin is compared with the configured one first, and
 * the mismatch is reported with both values and the two places they have to
 * agree. This never *fixes* the value — deriving the redirect URI from the
 * request would send Google something that was never registered, and it has to
 * match the value the callback later presents when it exchanges the code.
 */
export function redirectMismatch(request: Request): string | null {
  const configured = driveEnv().redirectUri;
  if (!configured) return null;

  let expected: URL;
  try {
    expected = new URL(configured);
  } catch {
    return null;
  }

  /*
   * The forwarded host, not `request.url`.
   *
   * Every hosting platform puts a proxy in front of the app, and Next
   * normalises `request.url` to the origin the server believes it is serving —
   * which is the internal one. Reading it would compare localhost against
   * localhost on a deployment whose public URL is something else entirely, and
   * this check would pass exactly where it is needed.
   *
   * `x-forwarded-host` is what the proxy sets; `host` is the fallback for a
   * direct connection.
   */
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (!host) return null;

  // A proxy terminates TLS and forwards http internally, so the scheme on the
  // inbound request is not evidence of anything. Host is what matters.
  if (expected.host === host) return null;

  const scheme = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "https";

  return (
    `This deployment is running on ${host}, but GOOGLE_REDIRECT_URI is set to ` +
    `${configured}. Google would refuse the sign-in with "redirect_uri_mismatch" and would not ` +
    `say why.\n\n` +
    `Two places have to agree, and neither is guessable from the other:\n\n` +
    `1. Set GOOGLE_REDIRECT_URI to ${scheme}://${host}/api/drive/callback in this deployment's ` +
    `environment settings, then redeploy.\n` +
    `2. Add that exact URL to the OAuth client's authorised redirect URIs at ` +
    `console.cloud.google.com/apis/credentials.\n\n` +
    `Keep the localhost value registered too if you also run this locally — a client may hold ` +
    `several, and removing one breaks the other machine.`
  );
}
