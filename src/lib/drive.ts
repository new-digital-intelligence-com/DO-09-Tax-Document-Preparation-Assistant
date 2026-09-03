import "server-only";

/**
 * Google Drive, over the REST API and nothing else.
 *
 * No `googleapis` dependency: this app needs six calls — list a folder, read a
 * file, write a file, replace a file, create a folder, and refresh a token —
 * and the client library is a hundred megabytes of surface for that. The REST
 * shapes are stable and documented, and a thin client that fails loudly is
 * easier to reason about than a thick one that retries silently.
 *
 * Auth is the OAuth authorization-code flow with a stored refresh token. A
 * service account would need the folder shared with a robot address that then
 * owns everything it writes; a refresh token acts as the person who owns the
 * folder, which is what "put the output back where the input came from"
 * actually means here.
 *
 * The important property for the rest of the app: every function throws with a
 * sentence a person can act on. A Drive outage must never reach the pipeline as
 * an empty folder — "no documents on Drive" and "Drive could not be read" lead
 * to opposite conclusions about a filing period, and only one of them is ever
 * true at a time.
 */

import { requireActiveUser } from "./users";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/**
 * Two grants, kept deliberately apart.
 *
 * **The workspace grant** is this app's own and asks for `drive.file` alone —
 * access to files this app creates or that are explicitly opened with it, and
 * nothing else in anybody's Drive. It owns the shared tax folder, and that is
 * the whole of its job. It is set up once by whoever runs the app.
 *
 * **The account grant** is per person and lives in `google-account.ts`: the
 * two scopes below, used when somebody imports an invoice out of their own
 * Drive, or emails the finished package from their own address. There is no
 * Gmail *read* scope anywhere in this app — importing attachments from a
 * mailbox was built and then deliberately removed, and the permission went
 * with it.
 *
 * They are separate because widening the workspace token would be a real cost
 * for no gain. Every user's documents are written through it, so a broader
 * scope on it would mean one token acting on behalf of everybody — and it
 * would force whoever set the app up to re-approve a permission the workspace
 * never uses. The scopes below are never attached to this token; they belong
 * to whichever person actually consented to them.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ────────────────────────────────────────────────────────────────────────── */

export function driveEnv() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/api/drive/callback",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN?.trim() ?? "",
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() ?? "",
  };
}

/** Whether a run can reach Drive at all. Three separate answers, on purpose. */
export function driveStatus(): {
  state: "ready" | "needs-consent" | "unconfigured";
  detail: string;
} {
  const env = driveEnv();
  if (!env.clientId || !env.clientSecret || !env.folderId) {
    return {
      state: "unconfigured",
      detail:
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_DRIVE_FOLDER_ID are not all set in " +
        ".env.local, so the workspace folder cannot be reached. The app runs against its local " +
        "corpus only.",
    };
  }
  if (!env.refreshToken) {
    return {
      state: "needs-consent",
      detail:
        "The Drive credentials are set but nobody has granted access yet. Open /api/drive/connect " +
        "once, approve, and the refresh token is written to .env.local.",
    };
  }
  return { state: "ready", detail: "Connected to the shared workspace folder." };
}

export function driveConfigured(): boolean {
  return driveStatus().state === "ready";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tokens
 * ────────────────────────────────────────────────────────────────────────── */

/** The consent URL. `offline` + `consent` is what actually returns a refresh token. */
export function consentUrl(): string {
  const env = driveEnv();
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    // Without `offline` Google returns an access token only, and the app stops
    // working an hour later with no way to recover unattended. `consent` forces
    // the refresh token to be reissued even for an account that has approved
    // this client before — otherwise a second setup silently gets nothing.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{
  refreshToken: string;
  accessToken: string;
}> {
  const env = driveEnv();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const body = (await response.json()) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new Error(
      `Google refused the authorisation code: ${body.error_description ?? body.error ?? response.status}. ` +
        `Check that ${env.redirectUri} is listed as an authorised redirect URI on this OAuth client.`,
    );
  }
  if (!body.refresh_token) {
    throw new Error(
      "Google returned an access token but no refresh token. That happens when the account has " +
        "already granted this client access — revoke it at myaccount.google.com/permissions and " +
        "try again, or the app will stop working when the access token expires.",
    );
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token ?? "" };
}

/**
 * Access tokens, cached in module scope until shortly before they expire.
 *
 * Refreshing on every call would work and would triple the request count on a
 * forty-document sweep. The sixty-second margin is there because the token is
 * checked here and used a moment later, and a token that expires in between
 * fails the call rather than the check.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  const status = driveStatus();
  if (status.state !== "ready") throw new Error(status.detail);

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const env = driveEnv();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    cachedToken = null;
    throw new Error(
      `Google would not refresh the Drive token: ${body.error_description ?? body.error ?? response.status}. ` +
        "If this says invalid_grant the stored refresh token has been revoked or expired — visit " +
        "/api/drive/connect and grant access again.",
    );
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Calls
 * ────────────────────────────────────────────────────────────────────────── */

async function call(path: string, init: RequestInit = {}, base = API): Promise<Response> {
  const token = await accessToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 404 on a folder we were given usually means the token's account cannot
    // see it, not that it is gone. Saying which saves a long hunt.
    const hint =
      response.status === 404
        ? " The account that granted access may not have this folder shared with it."
        : response.status === 403
          ? " The scope granted may not cover this file. Files created by other apps are outside drive.file."
          : "";
    throw new Error(`Drive ${init.method ?? "GET"} ${path} failed (${response.status}).${hint} ${text.slice(0, 300)}`);
  }
  return response;
}

/** Every non-trashed child of a folder, paged to the end. */
export async function listFolder(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, md5Checksum)",
      pageSize: "200",
      // Shared drives behave differently from My Drive and a folder can move
      // between them without anyone telling this app.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await call(`/files?${params.toString()}`);
    const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string };
    for (const file of body.files ?? []) {
      files.push({ ...file, size: file.size ? Number(file.size) : undefined });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Every workspace folder directly under the shared root — one per user.
 *
 * This is what makes the workspace list shared rather than per-machine: a
 * fresh checkout has no local record of anybody, but the folders on Drive are
 * the actual fact of who has a workspace, and this is how a second machine
 * finds them.
 */
export async function listRootFolders(): Promise<DriveFile[]> {
  const status = driveStatus();
  if (status.state !== "ready") throw new Error(status.detail);

  const rootId = driveEnv().folderId;
  const params = new URLSearchParams({
    q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, mimeType, size, modifiedTime, md5Checksum)",
    pageSize: "200",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await call(`/files?${params.toString()}`);
  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files ?? [];
}

export async function findInFolder(folderId: string, name: string): Promise<DriveFile | undefined> {
  const escaped = name.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name = '${escaped}' and trashed = false`,
    fields: "files(id, name, mimeType, size, modifiedTime, md5Checksum)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await call(`/files?${params.toString()}`);
  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files?.[0];
}

/**
 * A subfolder by name, created if it is not there.
 *
 * Find-then-create rather than create-blindly: Drive is happy to hold two
 * folders called `output` side by side, and a workspace that quietly grows a
 * second one loses half its cache with nothing to show that it did.
 */
export async function ensureFolder(parentId: string, name: string): Promise<string> {
  const existing = await findInFolder(parentId, name);
  if (existing && existing.mimeType === "application/vnd.google-apps.folder") return existing.id;

  const response = await call(`/files?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const body = (await response.json()) as { id: string };
  return body.id;
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const response = await call(`/files/${fileId}?alt=media&supportsAllDrives=true`);
  return Buffer.from(await response.arrayBuffer());
}

export async function readTextFile(fileId: string): Promise<string> {
  return (await downloadFile(fileId)).toString("utf8");
}

/**
 * Upload, as a multipart request built by hand.
 *
 * `fetch` will happily build a `FormData` body, but Drive's multipart endpoint
 * wants `multipart/related` with the metadata part first — not the
 * `multipart/form-data` that FormData produces. Assembling the body is a dozen
 * lines and removes an entire class of confusing 400s.
 */
export async function uploadFile(input: {
  parentId: string;
  name: string;
  bytes: Buffer;
  mimeType: string;
  /** Replace this file's content instead of creating a new one. */
  fileId?: string;
}): Promise<DriveFile> {
  const boundary = `do09-${Buffer.from(`${input.name}:${input.bytes.length}`).toString("hex").slice(0, 24)}`;
  const metadata = input.fileId
    ? { name: input.name }
    : { name: input.name, parents: [input.parentId] };

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${input.mimeType}\r\n\r\n`,
    ),
    input.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const path = input.fileId
    ? `/files/${input.fileId}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,md5Checksum`
    : `/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,md5Checksum`;

  const response = await call(
    path,
    {
      method: input.fileId ? "PATCH" : "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    },
    UPLOAD_API,
  );

  const file = (await response.json()) as DriveFile;
  return { ...file, size: file.size ? Number(file.size) : undefined };
}

/**
 * Write a file, replacing one of the same name in the same folder.
 *
 * `fileId` lets a caller that already knows which file it is overwriting skip
 * the lookup. Drive keeps a file's id across an overwrite — a `PATCH` replaces
 * the content in place — so a caller writing the same file repeatedly can
 * remember the id once and spend one round trip per write instead of two. Pass
 * it only where a stale id is recoverable: if the file was trashed underneath
 * you the `PATCH` fails, and the caller has to drop the id and try again
 * without it.
 */
export async function putFile(input: {
  parentId: string;
  name: string;
  bytes: Buffer;
  mimeType: string;
  fileId?: string;
}): Promise<DriveFile> {
  const fileId = input.fileId ?? (await findInFolder(input.parentId, input.name))?.id;
  return uploadFile({ ...input, fileId });
}

/** Convenience for the JSON the pipeline caches. */
export async function putJson(
  parentId: string,
  name: string,
  value: unknown,
  fileId?: string,
): Promise<DriveFile> {
  return putFile({
    parentId,
    name,
    bytes: Buffer.from(JSON.stringify(value, null, 2), "utf8"),
    mimeType: "application/json",
    fileId,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The workspace
 * ────────────────────────────────────────────────────────────────────────── */

export type Workspace = {
  rootId: string;
  /** The user's own folder inside the root: `<slug>-<id>`. */
  userFolderId: string;
  userFolderName: string;
  inputId: string;
  outputId: string;
  /** Everything `store.ts` persists — the document register, exceptions, forms, audit trail. */
  stateId: string;
};

/**
 * Keyed by user, and holding only Drive folder IDs — never a document, a
 * figure or anything a person typed. Losing this on a restart costs three
 * `ensureFolder` calls the next time the workspace is touched, nothing more;
 * it exists purely so a run over forty documents does not resolve the same
 * three folder ids forty times.
 */
const cachedWorkspaces = new Map<string, Workspace>();

/**
 * One user's `input`, `output` and `state` folders.
 *
 * The shape on Drive is a folder per user inside the shared root:
 *
 *     do-09 test/
 *       helmi-mf3k9x2a/
 *         profile.json
 *         input/     the documents
 *         output/    one <sha256>.json per processed document
 *         state/     the register: documents, extractions, classifications,
 *                    exceptions, forms, packages, audit — one JSON file per
 *                    collection. This is the ONLY place any of that lives.
 *                    There is no local copy, on this machine or any other —
 *                    every read and every write goes through this folder.
 *
 * A folder per user rather than a filename convention inside one, because the
 * folder is the unit people actually share, move and look at. Somebody wanting
 * to hand their accountant this quarter's documents can share one folder; with
 * everything in a single pile they would be sharing everybody's.
 *
 * `requireActiveUser()` now resolves the user by reading Drive's own folder
 * listing, so `user.driveFolderId` is always the real, current id — there is
 * nothing here to "remember" across a restart or double-check for staleness.
 */
export async function workspace(): Promise<Workspace> {
  const user = await requireActiveUser();
  const cached = cachedWorkspaces.get(user.id);
  if (cached) return cached;

  const [inputId, outputId, stateId] = await Promise.all([
    ensureFolder(user.driveFolderId, "input"),
    ensureFolder(user.driveFolderId, "output"),
    ensureFolder(user.driveFolderId, "state"),
  ]);

  const resolved: Workspace = {
    rootId: driveEnv().folderId,
    userFolderId: user.driveFolderId,
    userFolderName: user.driveFolderName,
    inputId,
    outputId,
    stateId,
  };
  cachedWorkspaces.set(user.id, resolved);
  return resolved;
}

/** Drop cached folder ids and tokens, for when the root folder is repointed. */
export function forgetWorkspace(): void {
  cachedWorkspaces.clear();
  cachedToken = null;
}

/**
 * Move a file to Drive's trash, reversibly.
 *
 * Used when a document turns out not to belong in the shared workspace —
 * declined as out of scope, or explicitly removed from the register. Trash
 * rather than permanent deletion: a person who uploaded the wrong file by
 * mistake can still recover it from Drive's own trash, and this app has no
 * "are you sure, really" step of its own to put in front of something
 * unrecoverable.
 */
export async function trashFile(fileId: string): Promise<void> {
  await call(`/files/${fileId}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}
