import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireActiveUser, userDataDir } from "./users";

/**
 * The register's storage: JSON files under `.data/users/<userId>/`.
 *
 * Documents, extractions, categorisations, the ledger, matches, exceptions,
 * form drafts, packages and the audit trail all live here. Nothing else in the
 * app knows or cares how they are persisted — everything goes through
 * `readStore` / `writeStore` / `mutate` / `append`.
 *
 * **Every one of those is scoped to the active user.** That is not a
 * convenience: this app prepares tax filings, and one person's receipts
 * appearing in another person's Schedule C is the worst thing it could quietly
 * do. Scoping in the storage layer rather than in each caller means a new
 * module cannot forget — there is no unscoped path to reach for.
 *
 * The user registry itself is the one thing that cannot live here, since it is
 * what answers "which user". It keeps its own file in `users.ts`.
 *
 * Swap this for a database when it serves more than one operator; the shapes
 * above it are narrow enough that nothing else has to change.
 */

async function file(name: string): Promise<string> {
  const user = await requireActiveUser();
  const dir = userDataDir(user.id);
  await mkdir(dir, { recursive: true });
  return path.join(dir, `${name}.json`);
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(await file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes go through a temp file and a rename.
 *
 * An audit trail truncated by a crash mid-write reads afterwards as "nothing
 * happened", which is worse than useless. A rename is atomic on the same
 * filesystem, so a reader sees either the old file or the whole new one.
 */
export async function writeStore<T>(name: string, value: T): Promise<void> {
  const target = await file(name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, target);
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
  return mutate<T[], T>(name, [], (log) => ({
    next: [record, ...log].slice(0, cap),
    result: record,
  }));
}

/**
 * Serialise read-modify-write on one collection.
 *
 * Two extractions landing at once would otherwise each read the same array and
 * the second write would drop the first result. The chain is keyed by user and
 * collection together: two users working the same collection have no reason to
 * queue behind each other, and one long run would stall the other.
 *
 * A per-name promise chain is enough while this is one process; a database
 * transaction replaces it when it is not.
 */
const chains = new Map<string, Promise<unknown>>();

export async function mutate<T, R>(
  name: string,
  fallback: T,
  change: (current: T) => Promise<{ next: T; result: R }> | { next: T; result: R },
): Promise<R> {
  const user = await requireActiveUser();
  const key = `${user.id}:${name}`;

  const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
    const current = await readStore<T>(name, fallback);
    const { next, result } = await change(current);
    await writeStore(name, next);
    return result;
  });

  // Keep the chain alive even when this link rejects, or one failed write would
  // deadlock every later write to the same collection.
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run as Promise<R>;
}

/** Where this user's document files live. */
export async function documentsDir(): Promise<string> {
  const user = await requireActiveUser();
  const dir = path.join(userDataDir(user.id), "documents");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Sortable, readable, and unique enough for a single-tenant register. */
export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${noise}`;
}
