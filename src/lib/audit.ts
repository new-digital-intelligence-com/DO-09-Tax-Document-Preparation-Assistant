import "server-only";
import { append, appendMany, newId, readStore } from "./store";
import type { AuditEvent } from "./types";

/**
 * The audit trail.
 *
 * Append-only by construction: there is no update and no delete in this module,
 * and nothing else in the app writes `audit.json`. A trail that can be edited
 * answers no question worth asking.
 *
 * What lands here is not only what the app did. Every irreversible action in
 * the console — resolving an exception, accepting one, overriding a category,
 * handing a package off, deleting a document — carries a note the person typed,
 * and the note is the reason the row is worth keeping. A closed item with no
 * note says somebody dealt with this and nothing about what they did; six
 * months on that is indistinguishable from nobody having looked.
 *
 * Failures are recorded as readily as successes. A refused deletion, a model
 * call that came back empty, a re-extraction that overwrote an earlier figure —
 * each is a row. An attempt that leaves no trace reads afterwards as an attempt
 * that never happened.
 */
export async function record(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  const entry: AuditEvent = {
    ...event,
    id: newId("aud"),
    at: new Date().toISOString(),
  };
  /**
   * `append`, never a rewrite: the trail only ever grows at the front, and the
   * cap trims the far end. 20000 rows is a real limit, not a formality — a
   * deployment busy enough to reach it has outgrown a JSON file and needs a
   * database. The cap is here rather than absent so a runaway loop fills the
   * disk with nothing.
   */
  return append<AuditEvent>("audit", entry, 20000);
}

/**
 * `record`, for several events from one operation.
 *
 * Exists for a bulk sweep — a hundred new documents found on Drive at once —
 * where a hundred calls to `record` would each read and rewrite the whole
 * trail. Pass events oldest-first, the order they actually happened in.
 */
export async function recordMany(events: Omit<AuditEvent, "id" | "at">[]): Promise<AuditEvent[]> {
  const now = Date.now();
  const entries: AuditEvent[] = events.map((event, i) => ({
    ...event,
    id: newId("aud"),
    // Spread by a millisecond each so two events from the same batch never
    // share a timestamp — sorting or de-duplicating by `at` elsewhere stays
    // meaningful.
    at: new Date(now + i).toISOString(),
  }));
  return appendMany<AuditEvent>("audit", entries, 20000);
}

/**
 * Read the trail, newest first.
 *
 * The order is a property of how it is written, not of a sort applied here —
 * re-sorting by timestamp would let a row with a bad clock jump the queue and
 * change what "the last thing that happened" means.
 *
 * `action` matches on substring so a caller can ask for a family of events
 * (`document.` catches ingest, duplicate and delete alike); everything else is
 * an exact match, because a partial match on a document id would return another
 * document's history.
 */
export async function listAudit(filter?: {
  periodId?: string;
  docId?: string;
  exceptionId?: string;
  action?: string;
  actor?: string;
  /**
   * Free text across the detail and the subject.
   *
   * The trail is the only place a deleted document survives, and what survives
   * of it is its filename — written into the detail sentence, not into a field.
   * Without this the only way to ask "what happened to invoice-42.pdf" is to
   * already know its id, which is exactly the thing somebody asking that
   * question does not have. Filtering by action alone is no better: it returns
   * every deletion in the period and leaves the reader to scan.
   */
  query?: string;
  limit?: number;
}): Promise<AuditEvent[]> {
  const log = await readStore<AuditEvent[]>("audit", []);
  const actor = filter?.actor?.trim().toLowerCase();
  const query = filter?.query?.trim().toLowerCase();

  const matched = log.filter((event) => {
    if (filter?.periodId && event.periodId !== filter.periodId) return false;
    if (filter?.docId && event.docId !== filter.docId) return false;
    if (filter?.exceptionId && event.exceptionId !== filter.exceptionId) return false;
    if (filter?.action && !event.action.includes(filter.action)) return false;
    if (actor && event.actor.trim().toLowerCase() !== actor) return false;
    if (query) {
      const haystack = `${event.detail} ${event.subject} ${event.action}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  return matched.slice(0, filter?.limit ?? 200);
}
