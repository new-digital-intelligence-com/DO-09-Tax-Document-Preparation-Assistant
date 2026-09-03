import { activeUser, setActiveUser } from "@/lib/users";
import { forgetWorkspace } from "@/lib/drive";
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
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const id = str(payload.id);
    if (!id) return bad("Send the id of the user to switch to.");

    const user = await setActiveUser(id);
    forgetWorkspace();
    return ok({ active: user });
  } catch (error) {
    if (error instanceof Error && /No user with id|must be a JSON/.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The user could not be switched.");
  }
}
