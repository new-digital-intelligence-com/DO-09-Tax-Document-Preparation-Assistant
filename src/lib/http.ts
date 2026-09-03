import { NextResponse } from "next/server";

/**
 * The shapes every route agrees on.
 *
 * Two rules live here rather than in eighteen copies.
 *
 * `bad` is for a request that could not be understood, and it says what was
 * expected — a 400 reading "invalid input" makes the caller guess, and the
 * caller is usually a panel that cannot.
 *
 * `failed` turns a thrown error into a status. It never swallows one into an
 * empty success: a route that answers `[]` because a read failed tells the
 * reviewer their period is clean, which is the exact failure this product is
 * built to prevent.
 */

export function ok<T>(value: T, status = 200) {
  return NextResponse.json(value, { status });
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function failed(error: unknown, fallback: string) {
  const message = error instanceof Error ? explain(error) : fallback;
  // Also to the server log, with the stack. The browser gets a sentence; the
  // person debugging needs the line it came from.
  console.error("[route]", fallback, error);
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * An error message that says what actually went wrong.
 *
 * Node's `fetch` throws a bare `TypeError: fetch failed` and hides the real
 * reason — the DNS failure, the reset connection, the timeout — one level down
 * in `cause`. Reporting only the top-level message tells a person that
 * something involving a network call did not work, which they already knew,
 * and gives them nothing to act on: a workspace whose Drive token has expired
 * and one behind a dropped Wi-Fi connection produce the identical sentence.
 *
 * So the chain is walked and the causes appended. `ECONNREFUSED` and
 * `ETIMEDOUT` and `ENOTFOUND` mean different things to whoever has to fix it.
 */
function explain(error: Error): string {
  const parts: string[] = [error.message];
  let cause: unknown = error.cause;

  for (let depth = 0; depth < 4 && cause; depth += 1) {
    if (!(cause instanceof Error)) {
      parts.push(String(cause));
      break;
    }
    const code = (cause as NodeJS.ErrnoException).code;
    parts.push(code && !cause.message.includes(code) ? `${cause.message} (${code})` : cause.message);
    cause = cause.cause;
  }

  return parts.join(" — ");
}

/** Parse a JSON body, or explain why it could not be. */
export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    throw new Error("The request body must be a JSON object.");
  }
  throw new Error("The request body must be a JSON object.");
}

/**
 * A required free-text reason.
 *
 * Every route that changes a record a reviewer will act on takes one of these.
 * It is not ceremony: the note is what the audit trail carries, and a closed
 * item with no note is indistinguishable six months later from one nobody
 * looked at.
 */
export function requireNote(value: unknown, what: string): string {
  const note = typeof value === "string" ? value.trim() : "";
  if (!note) {
    throw new Error(
      `${what} needs a note saying what was found or decided. It is written to the audit trail, ` +
        `and a record closed without one reads later as a record nobody looked at.`,
    );
  }
  return note;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
