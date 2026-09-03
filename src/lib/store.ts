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
 * does not protect against a second *process* writing to the same Drive folder
 * at the same time; nothing in a shared-folder-of-JSON-files design can.
 *
 * That limit is worth stating precisely, because deploying changes how often it
 * bites. Run locally there is one process, so the queue covers every write the
 * app makes and the gap only opens when a second machine is pointed at the same
 * workspace. Run on a serverless platform there is no single process at all:
 * two concurrent requests can land on two instances, each reads the same
 * collection, and the second write silently discards the first. The window is
 * small — a read and a write, a second or so — and the collections that take
 * concurrent writes in practice are the ones a bulk run touches.
 *
 * This is accepted rather than solved. Solving it needs a lock the store does
 * not have, and Drive offers nothing to build one from. What must not happen is
 * pretending otherwise: if two people work one workspace simultaneously on a
 * hosted deployment, a row can be lost, and the audit trail is where that shows
 * up as a gap rather than as an error.
 *
 * Every other module reaches this through `readStore` / `writeStore` /
 * `mutate` / `append`, unaware that the ground underneath changed — the
 * contract is identical to what a local-disk implementation would offer, so
 * nothing downstream had to change to stop being local.
 */

/**
 * A few seconds' memory of what Drive just said.
 *
 * Not a store, and nothing here survives the process — it is a debounce, and
 * the reason it earns its place is that one screen asks the same question
 * several times in a row. The documents tab alone reads the register, the
 * extractions, the categorisations and the exceptions; the status bar reads
 * most of them again a moment later. Without this, each of those is a fresh
 * round trip to Drive for an answer that cannot have changed in the two
 * hundred milliseconds since the last one, and the page takes seconds to draw
 * for no reason a person would accept.
 *
 * The window is deliberately short. Drive is still the source of truth and a
 * change made elsewhere is picked up within a few seconds; any write from
 * THIS process drops the entry immediately, so nothing you do here is ever
 * served back to you stale.
 */
const CACHE_MS = 8_000;
const reads = new Map<string, { at: number; value: unknown }>();

/**
 * Which Drive file each collection lives in.
 *
 * A read used to cost two round trips: a search of `state/` for the file named
 * `documents.json`, then a download of whatever that search returned. A write
 * cost the same two. But a Drive file keeps its id when its contents are
 * replaced, so the search only ever tells us something we already learned the
 * first time — and it was being paid for on every read and every write, of
 * every collection, on every page. Remembering the id spends that lookup once
 * per collection per process and halves the traffic for the whole register.
 *
 * The id can go stale — somebody deletes `state/documents.json` in the Drive
 * web UI and the next read of it 404s. That is why both paths below drop the
 * remembered id and fall back to the search rather than reporting a failure:
 * a wrong id costs an extra round trip once, never a wrong answer.
 */
const fileIds = new Map<string, string>();

function cacheKey(userFolderId: string, name: string): string {
  return `${userFolderId}:${name}`;
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  try {
    const folders = await workspace();
    const key = cacheKey(folders.userFolderId, name);

    const hit = reads.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      // Handed back as a copy. Callers map and filter these arrays freely and
      // a shared reference would let one screen's work show up in another's.
      return JSON.parse(JSON.stringify(hit.value)) as T;
    }

    const known = fileIds.get(key);
    if (known) {
      try {
        const value = JSON.parse(await readTextFile(known)) as T;
        reads.set(key, { at: Date.now(), value });
        return value;
      } catch {
        fileIds.delete(key);
      }
    }

    const file = await findInFolder(folders.stateId, `${name}.json`);
    if (!file) {
      reads.set(key, { at: Date.now(), value: fallback });
      return fallback;
    }

    fileIds.set(key, file.id);
    const value = JSON.parse(await readTextFile(file.id)) as T;
    reads.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // A collection that was never written, or a parse failure on a row
    // something else left malformed, both read as "nothing here yet" — the
    // same answer a missing local file used to give. A genuine Drive outage
    // is caught and reported separately, by the callers that check
    // `driveStatus()` before relying on an empty result meaning anything.
    return fallback;
  }
}

/**
 * Writes go straight to Drive, and drop this collection's cached read on the
 * way through — so the next read of it goes and asks, rather than handing
 * back what was true before the write.
 */
export async function writeStore<T>(name: string, value: T): Promise<void> {
  const folders = await workspace();
  const key = cacheKey(folders.userFolderId, name);

  const known = fileIds.get(key);
  let file;
  try {
    file = await putJson(folders.stateId, `${name}.json`, value, known);
  } catch (error) {
    // A remembered id that no longer resolves is the one failure worth a
    // second attempt: drop it and let the write find the file by name, or
    // create it. Any other failure is real and belongs to the caller.
    if (!known) throw error;
    fileIds.delete(key);
    file = await putJson(folders.stateId, `${name}.json`, value);
  }

  fileIds.set(key, file.id);
  reads.set(key, { at: Date.now(), value });
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
