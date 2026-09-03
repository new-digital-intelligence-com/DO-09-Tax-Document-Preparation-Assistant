import { reopenException, resolveException } from "@/lib/exceptions";
import { preparer } from "@/lib/settings";
import { bad, body, failed, ok, requireNote, str } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Close a finding, or put one back.
 *
 * `accept` picks between two genuinely different outcomes, and the register
 * keeps them apart. "Resolved" says the underlying problem was fixed — the
 * missing invoice arrived, the ledger was corrected. "Accepted" says a person
 * looked and decided it is fine as it stands. Collapsing them into "closed"
 * loses the distinction the next reviewer most needs.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const id = str(payload.id);
    if (!id) return bad("Send the exception id.");

    const reopen = payload.reopen === true;
    const note = requireNote(
      payload.note,
      reopen ? "Reopening a finding" : "Closing a finding",
    );

    const exception = reopen
      ? await reopenException(id, preparer(), note)
      : await resolveException({ id, actor: preparer(), note, accept: payload.accept === true });

    return ok(exception);
  } catch (error) {
    if (error instanceof Error && /needs a note|must be a JSON|No exception|not open/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The finding could not be updated.");
  }
}
