import { handOff } from "@/lib/packages";
import { preparer, taxManager } from "@/lib/settings";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Hand the package to a person.
 *
 * It sends no mail — there is no connector in this build — and it does not
 * file. What it does is record who the pack went to and when, and hand back
 * the markdown to send. The record is the point: "it was handed over" with no
 * name against it is the state where everyone assumes somebody else has it.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const packageId = str(payload.packageId);
    if (!packageId) return bad("Send the packageId.");

    const to = str(payload.to) ?? taxManager();
    if (!to || to.includes("example.invalid")) {
      return bad(
        "No recipient. Set TAX_MANAGER_EMAIL, or send an explicit `to` — a handoff with nobody " +
          "named is a package nobody is waiting for.",
      );
    }

    if (to === preparer()) {
      return bad(
        "The package cannot be handed to the address that prepared it. A second person reviewing " +
          "it before filing is the whole point of the handoff.",
      );
    }

    return ok(await handOff({ packageId, actor: preparer(), to, note: str(payload.note) }));
  } catch (error) {
    if (error instanceof Error && /No package|must be a JSON/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The handoff could not be recorded.");
  }
}
