import "server-only";
import { findInFolder, putJson, readTextFile, workspace } from "./drive";

/**
 * The register's storage: Drive, and Drive only.
 *
 * Documents, extractions, categorisations, exceptions, form drafts, packages
 * and the audit trail all live as JSON files in the active user's `state/`
 * folder on Drive — nothing here is ever written to this machine's disk.
 * Every read genuinely asks Drive; every write genuinely goes to Drive. There
 * is no local cache to fall out of sync with it, no `.data/` directory to lose
 * track of, and no difference between opening this app on the machine that
 * seeded it and opening it on one that has never touched it before — both ask
 * Drive the same question and get the same answer.
 *
 * That correctness costs a network round trip on every read and every write.
 * It is spent deliberately: the alternative is a local copy that can disagree
 * with what is actually on Drive, and a tax register that quietly drifted from
 * the shared source of truth is a worse failure than a slow page load.
 *
 * `mutate`'s per-name promise chain is the one thing kept in memory rather
 * than asked of Drive on every call — it is not data, it is a queue, gone the
 * moment this process exits, and it exists only to stop two writes landing on
 * the same collection from this one process at the same moment. It cannot and
 * does not protect against a second machine writing to the same Drive folder
 * at the same time; nothing in a shared-folder-of-JSON-files design can. That
 * risk is accepted, not solved, the same way it always was the moment more
 * than one machine could touch the same workspace.
 *
 * Every other module reaches this through `readStore` / `writeStore` /
 * `mutate` / `append`, unaware that the ground underneath changed — the
 * contract is identical to what a local-disk implementation would offer, so
 * nothing downstream had to change to stop being local.
 */

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  try {
    const folders = await workspace();
    const file = await findInFolder(folders.stateId, `${name}.json`);
    if (!file) return fallback;
    return JSON.parse(await readTextFile(file.id)) as T;
  } catch {
    // A collection that was never written, or a parse failure on a row
    // something else left malformed, both read as "nothing here yet" — the
    // same answer a missing local file used to give. A genuine Drive outage
    // is caught and reported separately, by the callers that check
    // `driveStatus()` before relying on an empty result meaning anything.
    return fallback;
  }
}

/** Writes go straight to Drive; there is nothing else to keep in step with. */
export async function writeStore<T>(name: string, value: T): Promise<void> {
  const folders = await workspace();
  await putJson(folders.stateId, `${name}.json`, value);
}

/**
 * Add one record to an append-only collection.
 *
 * Separate from `writeStore` so the trail is never replaced wholesale — the
 * only way in is the front.
 */
export async function append<T extends { id: string }>(
  name: string,
  record: T,
  cap = 20000,
): Promise<T> {
  const [result] = await appendMany(name, [record], cap);
  return result;
}

/**
 * Add several records in one read-modify-write.
 *
 * `append` costs one Drive read and one Drive write. Calling it N times in a
 * loop costs N of each — and each of those N writes carries the WHOLE
 * collection, which grows on every iteration. A sync that finds thirty-nine
 * new documents and logs one audit row per document would, through `append`
 * alone, read and rewrite an audit trail that is already hundreds of rows
 * long thirty-nine separate times. This does the same append, once.
 *
 * `records` is given oldest-first — the order they happened in — and the
 * result is stored newest-first, matching what a sequence of plain `append`
 * calls would have produced.
 */
export async function appendMany<T extends { id: string }>(
  name: string,
  records: T[],
  cap = 20000,
): Promise<T[]> {
  if (records.length === 0) return [];
  return mutate<T[], T[]>(name, [], (log) => ({
    next: [...records].reverse().concat(log).slice(0, cap),
    result: records,
  }));
}

/**
 * Serialise read-modify-write on one collection, within this process.
 *
 * Two extractions landing at once in the SAME running server would otherwise
 * each read the same Drive file and the second write would drop the first
 * result — this queue is what stops that. It is keyed by user and collection
 * together, so two users working different corpora never queue behind each
 * other, and it is pure in-memory bookkeeping: nothing it tracks is a value
 * this app stores, only the order two writes happen in.
 */
const chains = new Map<string, Promise<unknown>>();

export async function mutate<T, R>(
  name: string,
  fallback: T,
  change: (current: T) => Promise<{ next: T; result: R }> | { next: T; result: R },
): Promise<R> {
  // Resolving the user id here, before the chain, means the queue key is
  // stable for the duration of this call even if the active workspace is
  // switched moments later by another request.
  const folders = await workspace();
  const key = `${folders.userFolderId}:${name}`;

  const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
    const current = await readStore<T>(name, fallback);
    const { next, result } = await change(current);
    await writeStore(name, next);
    return result;
  });

  // Keep the chain alive even when this link rejects, or one failed write
  // would deadlock every later write to the same collection.
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run as Promise<R>;
}

/** Sortable, readable, and unique enough for a single-tenant register. */
export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${noise}`;
}
