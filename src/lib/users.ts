import "server-only";
import { cookies } from "next/headers";
import { scopedWorkspaceId } from "./workspace-context";
import { driveConfigured, driveEnv, ensureFolder, findInFolder, listRootFolders, putJson, readTextFile } from "./drive";

/**
 * Who the workspace is being prepared for.
 *
 * Everything in this app is scoped to one user: their documents, their
 * extractions, their flags, their drafts, and their own `input`, `output` and
 * `state` folders on Drive. There is no local list of who has a workspace —
 * the folders under the shared root ARE the list, read fresh every time. A
 * `profile.json` inside each one carries the name; a folder without one (one
 * predating this file, or made by hand on Drive) gets a name recovered from
 * its folder name, and the profile is written back so it only has to be
 * guessed once.
 *
 * There is no sign-in — this is a local tool with a picker, not an
 * authenticated product — so "the current user" is a deliberate choice
 * somebody made on the front screen, not an identity anybody proved. It lives
 * in an HTTP cookie rather than anywhere on this server, which is what makes
 * it genuinely per-browser: two tabs, or two machines, open against the same
 * server each have their own active workspace, where a server-side file ever
 * could only have had one.
 */

export type User = {
  /** Stable key, and the name of this user's folder on Drive. */
  id: string;
  /** What the person typed. Shown everywhere. */
  name: string;
  /** Lowercase, hyphenated form of the name. */
  slug: string;
  /** This user's own folder, directly under the shared Drive root. */
  driveFolderId: string;
  /** The folder's name on Drive: `<slug>-<id>`. Fixed at creation. */
  driveFolderName: string;
  createdAt: string;
  lastUsedAt?: string;
};

type Profile = { id: string; name: string; slug: string; createdAt: string; lastUsedAt?: string };

const ACTIVE_USER_COOKIE = "do09_active_user";

/* ────────────────────────────────────────────────────────────────────────────
 * Naming
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A name reduced to something safe for a Drive folder.
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

/** The unique half of the folder name, time-ordered so listings sort roughly by age. */
function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Recover a plausible name from a folder that has no `profile.json`.
 *
 * A workspace folder is `<slug>-<uniqueid>`. The slug is everything before the
 * last hyphen-delimited chunk — deliberately simple rather than parsed against
 * `slugify`'s exact alphabet, because a folder this old may predate a change
 * to that function, and a name is worth recovering even from one this code did
 * not itself create.
 */
function nameFromFolderName(folderName: string): string {
  const withoutId = folderName.replace(/-[a-z0-9]+$/i, "");
  const words = (withoutId || folderName).split("-").filter(Boolean);
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || folderName;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Every workspace that exists, read straight off Drive.
 *
 * No local file backs this — the folders under the shared root are the list,
 * so opening this app from a machine that has never touched a workspace
 * before returns exactly what the machine that created one would see.
 *
 * What IS kept, briefly, in memory: the result of the last scan, for a few
 * seconds. This is not a store of anything the user typed — it is a debounce
 * on top of `store.ts`'s design, and the reason it matters more here than it
 * sounds: EVERY read and write in this app resolves "who is the active user"
 * first, and that resolution is this exact scan — a folder listing plus one
 * `profile.json` read per workspace. Without the debounce, a single screen
 * that touches five collections pays for that scan five times over, and nine
 * screens loading in sequence pay for it forty-five times over, for an answer
 * that cannot possibly have changed between the first call and the last one
 * a few hundred milliseconds later. `invalidateUsers()` clears it the moment
 * anything that could change the answer actually happens.
 */
let usersCache: { at: number; users: User[] } | null = null;
const USERS_CACHE_MS = 15_000;

export function invalidateUsers(): void {
  usersCache = null;
}

async function scanUsers(): Promise<User[]> {
  const folders = await listRootFolders();
  const users: User[] = [];

  for (const folder of folders) {
    let profile: Profile | undefined;
    try {
      const file = await findInFolder(folder.id, "profile.json");
      if (file) profile = JSON.parse(await readTextFile(file.id)) as Profile;
    } catch {
      profile = undefined;
    }

    if (profile) {
      users.push({
        id: profile.id,
        name: profile.name,
        slug: profile.slug,
        driveFolderId: folder.id,
        driveFolderName: folder.name,
        createdAt: profile.createdAt,
        lastUsedAt: profile.lastUsedAt,
      });
      continue;
    }

    const name = nameFromFolderName(folder.name);
    const recovered: Profile = { id: folder.name, name, slug: slugify(name), createdAt: new Date().toISOString() };
    try {
      await putJson(folder.id, "profile.json", recovered);
    } catch {
      // Still usable for this request even if the write-back fails; the next
      // scan simply has to recover the name the same way again.
    }
    users.push({ ...recovered, driveFolderId: folder.id, driveFolderName: folder.name });
  }

  return users.sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
}

export async function listUsers(): Promise<User[]> {
  if (!driveConfigured()) return [];

  if (usersCache && Date.now() - usersCache.at < USERS_CACHE_MS) return usersCache.users;

  const users = await scanUsers();
  usersCache = { at: Date.now(), users };
  return users;
}

export async function getUser(id: string): Promise<User | undefined> {
  return (await listUsers()).find((user) => user.id === id);
}

/**
 * The user this browser is working as, or nothing.
 *
 * Returning `undefined` rather than inventing a default is the point: a
 * console that silently picked somebody's workspace because none was chosen
 * would show one person's figures under another person's name.
 */
export async function activeUser(): Promise<User | undefined> {
  /*
   * A call carrying its own workspace wins over the cookie.
   *
   * The console selects with a cookie because a browser resends it. The MCP
   * server cannot: every JSON-RPC call is a separate stateless request, so its
   * selection travels with the call instead. Checking that first keeps every
   * function below this one unaware that there are two ways in.
   */
  const scoped = scopedWorkspaceId();
  if (scoped) return getUser(scoped);

  const store = await cookies();
  const id = store.get(ACTIVE_USER_COOKIE)?.value;
  if (!id) return undefined;
  return getUser(id);
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

/* ────────────────────────────────────────────────────────────────────────────
 * Writing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Add a user, or hand back the one that already answers to this name.
 *
 * Matching on the slug rather than the exact string, so "Helmi" and "helmi" are
 * one person. Creating a second workspace for a capitalisation difference would
 * split somebody's documents across two folders with nothing on screen saying
 * why half of them had vanished. Checked against Drive directly — never a local
 * list — because a local list is exactly what let this app once create a
 * second, empty folder for a name that already had thirty-nine documents.
 */
export async function createUser(name: string): Promise<{ user: User; created: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A user needs a name.");
  if (trimmed.length > 60) throw new Error("That name is too long — 60 characters at most.");
  if (!driveConfigured()) {
    throw new Error(
      "Drive is not connected, so a workspace cannot be created — there would be nowhere for it " +
        "to live. Connect Drive first.",
    );
  }

  const slug = slugify(trimmed);
  const existing = (await listUsers()).find((user) => user.slug === slug);
  if (existing) return { user: existing, created: false };

  const id = `${slug}-${uniqueId()}`;
  const createdAt = new Date().toISOString();
  const rootId = driveEnv().folderId;

  const folderId = await ensureFolder(rootId, id);
  await putJson(folderId, "profile.json", { id, name: trimmed, slug, createdAt });
  // The three folders this user's workspace needs are created now rather than
  // left to `workspace()` to discover lazily, so a brand-new workspace already
  // looks complete the moment somebody opens Drive to check it.
  await Promise.all([ensureFolder(folderId, "input"), ensureFolder(folderId, "output"), ensureFolder(folderId, "state")]);

  const user: User = { id, name: trimmed, slug, driveFolderId: folderId, driveFolderName: id, createdAt };
  invalidateUsers();
  return { user, created: true };
}

/**
 * Switch the active workspace.
 *
 * Held in a cookie set on this response, never in a file on this server —
 * there is nowhere here for "who is using this" to live. That also fixes a
 * sharper problem than tidiness: a server-side file makes every browser
 * talking to this instance share one active user, so switching workspaces in
 * one tab silently switches it under someone working in another. A cookie is
 * genuinely per-browser.
 */
export async function setActiveUser(id: string): Promise<User> {
  const user = await getUser(id);
  if (!user) throw new Error(`No user with id ${id}.`);

  const lastUsedAt = new Date().toISOString();
  try {
    await putJson(user.driveFolderId, "profile.json", {
      id: user.id,
      name: user.name,
      slug: user.slug,
      createdAt: user.createdAt,
      lastUsedAt,
    });
  } catch {
    // The switch below still succeeds even if this write fails; only the
    // "last opened" ordering on the picker is affected, not which workspace
    // opens.
  }

  const store = await cookies();
  store.set(ACTIVE_USER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // A year. There is nothing sensitive in the cookie beyond which of this
    // app's own workspaces was open last — it names a folder, not a secret.
    maxAge: 60 * 60 * 24 * 365,
  });

  invalidateUsers();
  return { ...user, lastUsedAt };
}
