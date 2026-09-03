import { activeUser, createUser, listUsers } from "@/lib/users";
import { driveStatus } from "@/lib/drive";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Who this instance knows about, and who it is currently working as.
 *
 * `active` is returned as `null` rather than defaulting to the first user. A
 * console that silently picked somebody's workspace because none was chosen
 * would show one person's figures under another person's name, and on a tax
 * filing that is not a cosmetic mistake.
 */
export async function GET() {
  try {
    const [users, current] = await Promise.all([listUsers(), activeUser()]);
    return ok({
      users,
      active: current ?? null,
      drive: driveStatus(),
    });
  } catch (error) {
    return failed(error, "The user list could not be read.");
  }
}

/**
 * Add a user.
 *
 * A name that matches one already here returns that user rather than creating a
 * second workspace beside it — see `createUser` for why a capitalisation
 * difference must not split somebody's documents in two.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const name = str(payload.name);
    if (!name) return bad("Send a name for the new user.");

    const { user, created } = await createUser(name);
    return ok({ user, created });
  } catch (error) {
    if (error instanceof Error && /needs a name|too long|must be a JSON/.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The user could not be created.");
  }
}
