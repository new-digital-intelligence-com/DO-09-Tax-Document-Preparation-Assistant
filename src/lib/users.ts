import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Who the workspace is being prepared for.
 *
 * Everything in this app is scoped to one user: their documents, their
 * extractions, their flags, their drafts, and their own `input` and
 * `output` folders on Drive. There is no sign-in — this is a local tool with a
 * picker, not an authenticated product — so "the current user" is a deliberate
 * choice somebody made on the front screen, not an identity anybody proved.
 *
 * That distinction is worth keeping honest about. Two people using the same
 * running instance share one active user, and the audit trail records the name
 * that was selected rather than the person who was typing. Put real
 * authentication in front of this before it leaves one machine.
 *
 * This module keeps its own storage rather than going through `store.ts`,
 * because `store.ts` is scoped BY the active user and asking it who that is
 * would be circular.
 */

export type User = {
  /** Stable key, and the directory name under `.data/users/`. */
  id: string;
  /** What the person typed. Shown everywhere. */
  name: string;
  /** Lowercase, hyphenated form of the name, used in the Drive folder name. */
  slug: string;
  /**
   * The folder on Drive holding this user's `input` and `output`.
   *
   * Resolved lazily and cached here: looking it up is three round trips and the
   * answer never changes for a given user.
   */
  driveFolderId?: string;
  /** The folder's name on Drive: `<slug>-<id>`. Fixed at creation. */
  driveFolderName: string;
  createdAt: string;
  lastUsedAt?: string;
};

type Registry = {
  users: User[];
  /** Id of the user the app is currently working as. */
  activeUserId?: string;
};

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "users.json");

const EMPTY: Registry = { users: [] };

async function readRegistry(): Promise<Registry> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Registry;
  } catch {
    return EMPTY;
  }
}

/** Same atomic write as `store.ts`: a half-written registry loses every user. */
async function writeRegistry(value: Registry): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, FILE);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Naming
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A name reduced to something safe for a directory and a Drive folder.
 *
 * Accents are folded rather than stripped, so "Hélène" becomes "helene" and not
 * "hlne". A name that reduces to nothing at all — punctuation, or a script this
 * fold does not cover — falls back to "user", because an empty slug would make
 * the folder name start with a hyphen and two such users indistinguishable.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "user";
}

/**
 * The unique half of the folder name.
 *
 * Time-ordered so a listing of the root folder sorts roughly by when each user
 * was added, with enough randomness that two people added in the same
 * millisecond do not collide.
 */
function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading
 * ────────────────────────────────────────────────────────────────────────── */

export async function listUsers(): Promise<User[]> {
  const registry = await readRegistry();
  return [...registry.users].sort(
    (a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt),
  );
}

export async function getUser(id: string): Promise<User | undefined> {
  return (await readRegistry()).users.find((user) => user.id === id);
}

/**
 * The user the app is working as, or nothing.
 *
 * Returning `undefined` rather than inventing a default is the point: a console
 * that silently picks somebody's workspace because none was chosen would show
 * one person's figures under another person's name.
 */
export async function activeUser(): Promise<User | undefined> {
  const registry = await readRegistry();
  if (!registry.activeUserId) return undefined;
  return registry.users.find((user) => user.id === registry.activeUserId);
}

/** Throws with an actionable sentence rather than returning a placeholder. */
export async function requireActiveUser(): Promise<User> {
  const user = await activeUser();
  if (!user) {
    throw new Error(
      "No user is selected, so there is no workspace to read. Choose one on the front screen, or " +
        "add one — every document, figure and draft in this app belongs to a named user.",
    );
  }
  return user;
}

/** Where this user's register lives on disk. */
export function userDataDir(userId: string): string {
  return path.join(DIR, "users", userId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Writing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Add a user, or hand back the one that already answers to this name.
 *
 * Matching on the slug rather than the exact string, so "Helmi" and "helmi" are
 * one person. Creating a second workspace for a capitalisation difference would
 * split somebody's documents across two folders with nothing on screen saying
 * why half of them had vanished.
 */
export async function createUser(name: string): Promise<{ user: User; created: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A user needs a name.");
  if (trimmed.length > 60) throw new Error("That name is too long — 60 characters at most.");

  const slug = slugify(trimmed);
  const registry = await readRegistry();

  const existing = registry.users.find((user) => user.slug === slug);
  if (existing) return { user: existing, created: false };

  const id = `${slug}-${uniqueId()}`;
  const user: User = {
    id,
    name: trimmed,
    slug,
    // The folder name is the id. Two names that collide on Drive would be a
    // nightmare to untangle, and the id already carries the uniqueness.
    driveFolderName: id,
    createdAt: new Date().toISOString(),
  };

  await writeRegistry({ ...registry, users: [...registry.users, user] });
  await mkdir(userDataDir(id), { recursive: true });
  return { user, created: true };
}

export async function setActiveUser(id: string): Promise<User> {
  const registry = await readRegistry();
  const user = registry.users.find((row) => row.id === id);
  if (!user) throw new Error(`No user with id ${id}.`);

  const stamped: User = { ...user, lastUsedAt: new Date().toISOString() };
  await writeRegistry({
    users: registry.users.map((row) => (row.id === id ? stamped : row)),
    activeUserId: id,
  });
  await mkdir(userDataDir(id), { recursive: true });
  return stamped;
}

/** Record the Drive folder once it has been resolved, so it is found once. */
export async function rememberDriveFolder(id: string, driveFolderId: string): Promise<void> {
  const registry = await readRegistry();
  await writeRegistry({
    ...registry,
    users: registry.users.map((row) => (row.id === id ? { ...row, driveFolderId } : row)),
  });
}

/**
 * Forget a user's Drive folder id.
 *
 * Used when the root folder is repointed: the cached id then names a folder
 * inside a workspace nobody is using any more, and writing this user's results
 * into it would put them somewhere nothing reads.
 */
export async function forgetDriveFolders(): Promise<void> {
  const registry = await readRegistry();
  await writeRegistry({
    ...registry,
    users: registry.users.map(({ driveFolderId: _drop, ...rest }) => rest),
  });
}
