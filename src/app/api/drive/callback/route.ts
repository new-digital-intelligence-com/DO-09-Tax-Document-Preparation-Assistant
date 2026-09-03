import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { driveEnv, exchangeCode, forgetWorkspace, workspace } from "@/lib/drive";
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

/** Replace the key in place if it is there, append it if it is not. */
async function storeRefreshToken(token: string): Promise<void> {
  let contents = "";
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch {
    // No .env.local yet: appending creates it.
  }

  if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(contents)) {
    await writeFile(
      ENV_PATH,
      contents.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${token}`),
      "utf8",
    );
    return;
  }
  await appendFile(ENV_PATH, `${contents.endsWith("\n") ? "" : "\n"}GOOGLE_REFRESH_TOKEN=${token}\n`, "utf8");
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;

  const error = query.get("error");
  if (error) {
    return page(
      "Access was not granted",
      `<p>Google returned <code>${error}</code>. Nothing was changed, and the app keeps working ` +
        `against its local corpus.</p>`,
      "bad",
    );
  }

  const code = query.get("code");
  if (!code) {
    return page("No authorisation code", "<p>Google sent no code back, so there is nothing to exchange.</p>", "bad");
  }

  try {
    const { refreshToken } = await exchangeCode(code);
    await storeRefreshToken(refreshToken);
    forgetWorkspace();

    // Prove the token reaches the folder before claiming it is connected.
    process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
    const folders = await workspace();

    await record({
      actor: preparer(),
      action: "drive.connected",
      subject: driveEnv().folderId,
      result: "ok",
      detail:
        `Drive access granted and the refresh token stored in .env.local. Workspace resolved: ` +
        `input ${folders.inputId}, output ${folders.outputId}.`,
    });

    return page(
      "Drive connected",
      `<p>The refresh token is stored in <code>.env.local</code>, and the <code>input</code> and ` +
        `<code>output</code> folders were both reached.</p>` +
        `<p><strong>Restart the dev server</strong> so it picks the token up from the environment — ` +
        `this process still holds the value it booted with.</p>`,
      "ok",
    );
  } catch (cause) {
    return page(
      "Could not complete the connection",
      `<p>${cause instanceof Error ? cause.message : "Unknown error"}</p>`,
      "bad",
    );
  }
}
