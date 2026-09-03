import "server-only";
import { DRIVE_READ_SCOPE, GMAIL_SEND_SCOPE, driveEnv, driveStatus } from "./drive";
import { readStore, writeStore } from "./store";

/**
 * Each person's own Google account, separate from the app's workspace token.
 *
 * There are two distinct Google connections in this app and conflating them
 * would be a privacy failure, not a tidiness one.
 *
 * The **workspace** connection is the app's own: one refresh token in
 * `.env.local`, owning the shared Drive folder where the register lives. It is
 * infrastructure. Every user's documents are written through it, and it is set
 * up once by whoever runs the app.
 *
 * The **account** connection is this file, and it is per person. When someone
 * wants to pull an invoice out of their own Drive or their own mailbox, that
 * is *their* Drive and *their* mailbox — not the app owner's. So each user
 * grants their own consent, their own refresh token is stored under their own
 * workspace, and one user can never list another's files. A single shared
 * token for imports would mean everybody browsing the app owner's mail, which
 * is not a feature anybody asked for.
 *
 * ## Where the token sits, and who can read it
 *
 * In `state/google.json` inside that user's folder — the same place their
 * documents and their register already live, so it is the same trust boundary
 * and not a new one. That boundary is worth stating plainly rather than
 * burying: every user folder is inside ONE shared Drive folder belonging to
 * ONE Google account, so whoever owns that folder can read what is in it. If
 * the people using this app do not already trust each other with their
 * documents, they should not be sharing a workspace root, and this token does
 * not change that calculation — it joins it.
 *
 * The refresh token is never sent to the browser. The connection is reported
 * as a boolean and an email address; the credential itself stays server-side.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * What this grant asks for, and nothing beyond it.
 *
 * Two scopes: read the person's Drive so they can import a document they
 * already have, and send mail so the finished package can go to their tax
 * manager from their own address.
 *
 * Notably absent is any Gmail *read* scope. Importing attachments straight
 * from a mailbox was built and then taken out, and the permission went with
 * it — a scope that is not requested cannot be misused, cannot widen later by
 * accident, and does not put "read your email" in front of somebody who only
 * wanted to attach an invoice.
 *
 * `drive.file` is absent for the same kind of reason: this grant never writes
 * to the person's own Drive. The workspace connection does all the writing,
 * into its own folder.
 */
export const ACCOUNT_SCOPES = [DRIVE_READ_SCOPE, GMAIL_SEND_SCOPE] as const;

type StoredAccount = {
  refreshToken: string;
  email?: string;
  scopes: string[];
  connectedAt: string;
};

export type AccountConnection = {
  connected: boolean;
  email?: string;
  connectedAt?: string;
  /** What this person's grant actually allows, feature by feature. */
  can: { driveImport: boolean; gmailSend: boolean };
  /** Why it cannot be connected at all, when that is the situation. */
  blocked?: string;
};

const NOT_CONNECTED: AccountConnection = {
  connected: false,
  can: { driveImport: false, gmailSend: false },
};

/* ────────────────────────────────────────────────────────────────────────────
 * Consent
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Where to send this person to approve access to their own account.
 *
 * `state` carries the user id back so the shared callback can tell a personal
 * connection from the app's own workspace setup. Reusing the one redirect URI
 * for both is not a shortcut: every redirect URI has to be registered by hand
 * on the Google OAuth client, and a second one would mean anybody deploying
 * this has to go and add it before the feature works at all.
 */
export function accountConsentUrl(userId: string): string {
  const env = driveEnv();
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: ACCOUNT_SCOPES.join(" "),
    access_type: "offline",
    // Without this a person who has approved before is bounced straight back
    // with no refresh token, and the connection silently does not happen.
    prompt: "consent",
    state: `user:${userId}`,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Turn the code Google sent back into a stored connection for one user. */
export async function connectAccount(code: string): Promise<AccountConnection> {
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
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new Error(
      `Google refused the authorisation code: ${body.error_description ?? body.error ?? response.status}.`,
    );
  }
  if (!body.refresh_token) {
    throw new Error(
      "Google returned an access token but no refresh token, so the connection would stop working " +
        "within the hour. Revoke this app at myaccount.google.com/permissions and connect again.",
    );
  }

  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  const email = body.access_token ? await whoami(body.access_token) : undefined;

  await writeStore<StoredAccount>("google", {
    refreshToken: body.refresh_token,
    email,
    scopes,
    connectedAt: new Date().toISOString(),
  });

  return describe({ refreshToken: body.refresh_token, email, scopes, connectedAt: new Date().toISOString() });
}

/** Forget one user's connection. Google-side revocation is asked for too. */
export async function disconnectAccount(): Promise<void> {
  const stored = await readStore<StoredAccount | null>("google", null);
  if (stored?.refreshToken) {
    // Best effort. A revocation Google refuses still has to clear the local
    // record, or the console would keep showing a connection that is gone.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${stored.refreshToken}`, {
      method: "POST",
    }).catch(() => undefined);
  }
  await writeStore<StoredAccount | null>("google", null);
  tokens.clear();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Using it
 * ────────────────────────────────────────────────────────────────────────── */

/** Access tokens per refresh token, held only in memory and only until they expire. */
const tokens = new Map<string, { value: string; expiresAt: number }>();

/**
 * An access token for the active user's own Google account.
 *
 * Throws rather than returning empty when there is no connection: every caller
 * is about to read somebody's mail or their Drive, and a call that quietly
 * proceeded with no credential would be reaching for the app's own token —
 * which is precisely the confusion this module exists to prevent.
 */
export async function accountToken(): Promise<string> {
  const stored = await readStore<StoredAccount | null>("google", null);
  if (!stored?.refreshToken) {
    throw new Error(
      "This workspace has no Google account connected. Connect one from Add documents, and only " +
        "the Drive files you pick are ever read.",
    );
  }

  const hit = tokens.get(stored.refreshToken);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;

  const env = driveEnv();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: stored.refreshToken,
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
    tokens.delete(stored.refreshToken);
    throw new Error(
      `Google would not refresh this account's token: ${body.error_description ?? body.error ?? response.status}. ` +
        "If it says invalid_grant the access was revoked — connect the account again.",
    );
  }

  tokens.set(stored.refreshToken, {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

/** What the active user's connection is and what it can do. */
export async function accountConnection(): Promise<AccountConnection> {
  if (driveStatus().state !== "ready") {
    return {
      ...NOT_CONNECTED,
      blocked:
        "The app's own Google credentials are not set up, so there is nothing to connect through yet.",
    };
  }

  try {
    const stored = await readStore<StoredAccount | null>("google", null);
    if (!stored?.refreshToken) return NOT_CONNECTED;
    return describe(stored);
  } catch {
    return NOT_CONNECTED;
  }
}

function describe(stored: StoredAccount): AccountConnection {
  const scopes = new Set(stored.scopes ?? []);
  return {
    connected: true,
    email: stored.email,
    connectedAt: stored.connectedAt,
    can: {
      driveImport: scopes.has(DRIVE_READ_SCOPE),
      gmailSend: scopes.has(GMAIL_SEND_SCOPE),
    },
  };
}

/** Whose account this is, so the console can show which one is connected. */
async function whoami(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { email?: string };
    return body.email;
  } catch {
    // A name for the connection is a nicety. Not having one is not a failure
    // worth refusing a working grant over.
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The person's own Drive
 * ────────────────────────────────────────────────────────────────────────── */

export type PersonalFile = {
  id: string;
  name: string;
  mimeType: string;
  bytes?: number;
  modifiedTime?: string;
  /** The folder path is not cheap to resolve, so this is the owner's own label. */
  from?: string;
};

const IMPORTABLE = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
] as const;

/**
 * Search the connected person's own Drive for documents worth importing.
 *
 * Read-only and scoped to their account: this lists what *they* can see, not
 * what the app owner can. The type filter is not cosmetic — offering somebody
 * their spreadsheets and slide decks in an invoice picker buries the four
 * files they came for under four hundred they did not.
 */
export async function searchPersonalDrive(
  query: string,
  limit = 40,
): Promise<PersonalFile[]> {
  const token = await accountToken();

  const clauses = [
    "trashed = false",
    `(${IMPORTABLE.map((type) => `mimeType = '${type}'`).join(" or ")})`,
  ];
  const text = query.trim();
  if (text) clauses.push(`name contains '${text.replace(/'/g, "\\'")}'`);

  const params = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id, name, mimeType, size, modifiedTime, owners(emailAddress))",
    pageSize: String(Math.min(Math.max(limit, 1), 100)),
    orderBy: "modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const hint =
      response.status === 403
        ? " The Drive read scope may not have been granted — reconnect and approve file access."
        : "";
    throw new Error(`Drive search failed (${response.status}).${hint} ${detail.slice(0, 240)}`);
  }

  const body = (await response.json()) as {
    files?: {
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
      owners?: { emailAddress?: string }[];
    }[];
  };

  return (body.files ?? []).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    bytes: file.size ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime,
    from: file.owners?.[0]?.emailAddress,
  }));
}

/** Download one file from the person's own Drive. */
export async function readPersonalFile(fileId: string): Promise<Buffer> {
  const token = await accountToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Could not download that file (${response.status}). ${detail.slice(0, 240)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * One file's details, by id.
 *
 * Separate from `searchPersonalDrive` because importing five files should cost
 * five metadata lookups, not five whole-Drive searches — and because a search
 * is capped and paged, so the file somebody explicitly picked may simply not
 * be in its results.
 */
export async function personalFileMeta(fileId: string): Promise<PersonalFile> {
  const token = await accountToken();
  const params = new URLSearchParams({
    fields: "id, name, mimeType, size, modifiedTime, owners(emailAddress)",
    supportsAllDrives: "true",
  });

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Could not read that file's details (${response.status}). ${detail.slice(0, 200)}`);
  }

  const file = (await response.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    owners?: { emailAddress?: string }[];
  };
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    bytes: file.size ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime,
    from: file.owners?.[0]?.emailAddress,
  };
}
