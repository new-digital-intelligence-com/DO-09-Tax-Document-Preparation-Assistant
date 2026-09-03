import { activeUser, setActiveUser } from "@/lib/users";
import { forgetWorkspace } from "@/lib/drive";
import { hydrateFromDrive } from "@/lib/workspace-sync";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    return ok({ active: (await activeUser()) ?? null });
  } catch (error) {
    return failed(error, "The active user could not be read.");
  }
}

/**
 * Switch the workspace.
 *
 * The Drive folder cache is dropped on the way through. It is keyed by user, so
 * this is belt and braces rather than a correctness fix — but a stale entry
 * here would write one person's results into another person's folder, and that
 * is the one failure in this app worth two lines of insurance.
 *
 * `hydrateFromDrive` runs right after: a workspace the picker found on Drive
 * may still be a blank slate on THIS machine — nothing has pulled its
 * documents and their answers down onto this disk yet. Without it, switching
 * to a workspace that plainly has documents on Drive shows an empty console
 * until somebody happens to press Run. It costs nothing beyond Drive traffic —
 * no model call is ever made here.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const id = str(payload.id);
    if (!id) return bad("Send the id of the user to switch to.");

    const user = await setActiveUser(id);
    forgetWorkspace();
    const pulled = await hydrateFromDrive(user.name);
    return ok({ active: user, pulled });
  } catch (error) {
    if (error instanceof Error && /No user with id|must be a JSON/.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The user could not be switched.");
  }
}
