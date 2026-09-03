import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { driveEnv, exchangeCode, forgetWorkspace, workspace } from "@/lib/drive";
import { connectAccount } from "@/lib/google-account";
import { record } from "@/lib/audit";
import { preparer } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Where Google sends the operator back, with a code.
 *
 * The refresh token is written into `.env.local` rather than shown on screen.
 * It is a long-lived credential: a page that prints it puts it in a browser
 * history, a screenshot and a support ticket, and revoking it afterwards is a
 * step nobody remembers to take.
 *
 * Writing it to disk does mean the running process still holds the old value
 * until it restarts — `process.env` is read at call time but Next only loads
 * `.env.local` at boot — so the page says to restart rather than pretending
 * the connection is live.
 */
const ENV_PATH = path.join(process.cwd(), ".env.local");

function page(title: string, body: string, tone: "ok" | "bad") {
  const accent = tone === "ok" ? "#0a6b3c" : "#b21b13";
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="margin:0;background:#fbfbfa;color:#16161a;font:14px/1.55 ui-sans-serif,system-ui,sans-serif">` +
      `<div style="max-width:640px;margin:14vh auto;padding:0 24px">` +
      `<p style="font:600 11px/1 ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#fe0100">DO-09</p>` +
      `<h1 style="margin:12px 0 0;font-size:26px;letter-spacing:-.02em;color:${accent}">${title}</h1>` +
      `<div style="margin-top:14px;color:#5c5c66">${body}</div>` +
      `<p style="margin-top:28px"><a href="/prep?section=documents" style="color:#16161a">Back to the console</a></p>` +
      `</div></body>`,
    { status: tone === "ok" ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Put the refresh token where the next boot will find it.
 *
 * On a machine with a writable disk that is `.env.local`, and the token never
 * reaches a browser. That is the right shape: it is a long-lived credential,
 * and a page that prints one puts it in a browser history, a screenshot and a
 * support ticket, and revoking it afterwards is the step nobody remembers.
 *
 * On a hosted deployment there is no writable disk. Vercel, Netlify and every
 * container platform serve from a read-only filesystem, and even where a write
 * appears to succeed the instance is thrown away minutes later — so a token
 * written to disk there is lost, and the connection silently stops working
 * within the hour when the access token expires.
 *
 * There is no third option. The token has to reach the platform's environment
 * settings, and the only route from Google's callback to there runs through the
 * person doing the setup. So on a read-only filesystem it is shown once, with
 * what to do with it, rather than written into the void and reported as
 * connected. Returning `"shown"` is what tells the page which of the two
 * happened, because telling somebody their connection is stored when it was not
 * is worse than asking them to paste a value.
 */
async function storeRefreshToken(token: string): Promise<"written" | "shown"> {
  let contents = "";
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch {
    // No .env.local yet. Not an error: appending creates it.
  }

  try {
    if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(contents)) {
      await writeFile(
        ENV_PATH,
        contents.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${token}`),
        "utf8",
      );
    } else {
      await appendFile(
        ENV_PATH,
        `${contents.endsWith("\n") || !contents ? "" : "\n"}GOOGLE_REFRESH_TOKEN=${token}\n`,
        "utf8",
      );
    }
    return "written";
  } catch {
    return "shown";
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;

  const error = query.get("error");
  if (error) {
    return page(
      "Access was not granted",
      `<p>Google returned <code>${error}</code>. Nothing was changed.</p>`,
      "bad",
    );
  }

  const code = query.get("code");
  if (!code) {
    return page("No authorisation code", "<p>Google sent no code back, so there is nothing to exchange.</p>", "bad");
  }

  /*
   * Two different connections come back through this one URL.
   *
   * `state=user:<id>` is a person connecting their OWN Google account so they
   * can import from their own Drive and mailbox. Everything else is the app's
   * own workspace setup, which writes a refresh token to `.env.local`.
   *
   * One redirect URI rather than two on purpose: every redirect URI has to be
   * registered by hand on the Google OAuth client, and adding a second would
   * mean this feature silently fails for anybody who did not know to go and
   * register it.
   */
  const state = query.get("state") ?? "";
  if (state.startsWith("user:")) {
    try {
      const connection = await connectAccount(code);
      const granted = [
        connection.can.driveImport ? "their Drive" : "",
        connection.can.gmailSend ? "sending on their behalf" : "",
      ].filter(Boolean);

      try {
        await record({
          actor: preparer(),
          action: "google.connected",
          subject: connection.email ?? "google-account",
          result: "ok",
          detail:
            `${connection.email ?? "A Google account"} was connected to this workspace for ` +
            `importing documents. Granted: ${granted.join(", ") || "nothing usable"}.`,
        });
      } catch {
        // Not being able to note it does not make the connection any less real.
      }

      return page(
        "Account connected",
        `<p>${connection.email ? `<strong>${connection.email}</strong>` : "The account"} is connected to ` +
          `this workspace.</p>` +
          (granted.length > 0
            ? `<p>You granted access to ${granted.join(", ")}. Only this account is read, and only ` +
              `the files you pick are imported.</p>`
            : `<p>No usable permission was granted, so nothing can be imported or sent yet. ` +
              `Connect again and approve access.</p>`) +
          `<p>Nothing needs restarting — this works immediately.</p>`,
        granted.length > 0 ? "ok" : "bad",
      );
    } catch (cause) {
      return page(
        "Could not connect that account",
        `<p>${cause instanceof Error ? cause.message : "Unknown error"}</p>` +
          `<p>Nothing was stored. You can <a href="/api/google/connect">try again</a>.</p>`,
        "bad",
      );
    }
  }

  /*
   * Only what happens before the token is stored can fail the connection.
   *
   * Everything after it is confirmation, and confirmation that fails must not
   * be reported as a connection that failed. The first version of this handler
   * did exactly that: the token was written, the folders were created, and the
   * page said "could not complete the connection" because a follow-up lookup
   * threw. The operator's next move is then to grant access again to fix
   * something that was never broken — and the authorisation code is single-use,
   * so that attempt fails too.
   */
  let refreshToken: string;
  let stored: "written" | "shown";
  try {
    refreshToken = (await exchangeCode(code)).refreshToken;
    stored = await storeRefreshToken(refreshToken);
  } catch (cause) {
    return page(
      "Could not complete the connection",
      `<p>${cause instanceof Error ? cause.message : "Unknown error"}</p>` +
        `<p>Nothing was stored, so nothing is half-connected. Try ` +
        `<a href="/api/drive/connect">granting access</a> again.</p>`,
      "bad",
    );
  }

  forgetWorkspace();
  process.env.GOOGLE_REFRESH_TOKEN = refreshToken;

  // Reaching the folders is reported separately, because it depends on a user
  // having been chosen and on this process seeing the new environment — neither
  // of which says anything about whether access was granted.
  let checked: string;
  try {
    const folders = await workspace();
    checked =
      `<p>The workspace was reached: <code>input</code> and <code>output</code> are both ready ` +
      `inside <code>${folders.userFolderName}</code>.</p>`;
  } catch (cause) {
    checked =
      `<p>The token is stored, but the folders could not be resolved from this process yet: ` +
      `${cause instanceof Error ? cause.message : "unknown error"}. That is expected before a ` +
      `restart, and expected if no workspace has been chosen yet.</p>`;
  }

  try {
    await record({
      actor: preparer(),
      action: "drive.connected",
      subject: driveEnv().folderId,
      result: "ok",
      detail:
        stored === "written"
          ? "Drive access granted and the refresh token stored in .env.local."
          : "Drive access granted. The filesystem is read-only, so the refresh token was shown " +
            "once for the operator to put into the deployment's environment settings rather " +
            "than written to disk.",
    });
  } catch {
    // The audit trail is scoped to a user and nobody may have chosen one.
    // Failing to note this is a far smaller problem than refusing a connection
    // that succeeded.
  }

  if (stored === "shown") {
    /*
     * The one place this app prints a credential, and only because there is
     * nowhere else for it to go.
     *
     * A hosted deployment has no writable disk and no persistent instance, so
     * the token cannot be saved from here — it has to reach the platform's own
     * environment settings, and the only path from Google's callback to there
     * runs through the person reading this page. Saying "connected" and writing
     * it nowhere would be the worse option: everything works until the access
     * token expires an hour later, and then nothing does, with no clue why.
     *
     * It is shown once and never logged, and the page says plainly to treat it
     * as compromised if it goes anywhere it should not.
     */
    return page(
      "Almost connected — one value to copy",
      `<p>Google granted access. This deployment has a <strong>read-only filesystem</strong>, so ` +
        `the refresh token could not be saved here and must go into your hosting platform's ` +
        `environment settings.</p>` +
        `<p>Set <code>GOOGLE_REFRESH_TOKEN</code> to:</p>` +
        `<p style="word-break:break-all;background:#f3f3f1;border:1px solid #e3e3e0;` +
        `border-radius:8px;padding:12px;font:12px/1.5 ui-monospace,monospace">${refreshToken}</p>` +
        `<p>Then redeploy. Until you do, nothing can reach the workspace folder.</p>` +
        `<p><strong>This is a long-lived credential.</strong> It is shown here once and is not ` +
        `written to any log. If it reaches a screenshot, a chat or a ticket, revoke it at ` +
        `<code>myaccount.google.com/permissions</code> and connect again.</p>`,
      "ok",
    );
  }

  return page(
    "Drive connected",
    `<p>The refresh token is stored in <code>.env.local</code>.</p>${checked}` +
      `<p><strong>Restart the dev server</strong> so it picks the token up from the environment — ` +
      `this process still holds the value it booted with.</p>`,
    "ok",
  );
}
