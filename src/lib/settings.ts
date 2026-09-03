import "server-only";
import { readStore, writeStore } from "./store";
import type { FilingPeriod, Settings } from "./types";

/**
 * Workspace settings, the filing period, and the handful of formatting helpers
 * that every surface has to agree on.
 *
 * Three layers, lowest first: the defaults below, then the environment, then
 * whatever a person saved in the console. The environment sits above the
 * defaults because a deployment says which entity it prepares for; the saved
 * settings sit above the environment because a value someone typed is a
 * decision, and a decision must not be quietly overwritten on the next deploy.
 *
 * The formatting helpers live here rather than in a `format.ts` because each of
 * them depends on something in `Settings` — the period, the currency, the tax
 * id — and a second copy of any of them is a second answer to the same
 * question.
 */

/**
 * The period this build ships with.
 *
 * A period carries its own entity, start, end, basis and currency rather than
 * reading them from `Settings` at display time: renaming the entity or moving
 * to accrual next year must not silently rewrite a quarter that was already
 * packaged and handed off. What a period was prepared under is a fact about
 * that period.
 */
const Q1_2025: FilingPeriod = {
  id: "period_2025_q1",
  label: "2025 Q1",
  entity: "Northwind Studio LLC",
  start: "2025-01-01",
  end: "2025-03-31",
  jurisdiction: "US-federal",
  basis: "cash",
  currency: "USD",
  status: "open",
};

export const DEFAULT_SETTINGS: Settings = {
  entity: "Northwind Studio LLC",
  jurisdiction: "US-federal",
  currency: "USD",
  basis: "cash",
  activePeriodId: Q1_2025.id,
  periods: [Q1_2025],
  /**
   * Stand-in addresses, not real people. `preparerConfigured()` and
   * `taxManagerConfigured()` are how the console tells an operator that the
   * name on an audit row is a placeholder rather than someone who could answer
   * for it.
   */
  preparerEmail: "tax-document-preparation-assistant@new-digital-intelligence.com",
  taxManagerEmail: "dana.whitfield@new-digital-intelligence.com",
  /**
   * Below this, a categorisation is flagged. 0.75 is deliberately high: the
   * cost of a flag is a minute of a reviewer's attention, and the cost of a
   * miss is a wrong figure on a form that a person signed.
   */
  reviewConfidence: 0.75,
  capitalisationThreshold: 2500,
  contractor1099Threshold: 600,
  recurrenceGapMonths: 1,
  /** Empty until someone sets a house style. `voicePrompt` adds nothing while it is. */
  voice: "",
};

/**
 * The environment layer.
 *
 * Only keys that are actually set are returned. An env var present but empty is
 * not an instruction — treating `ENTITY_NAME=` as an override would blank the
 * entity name on every draft form, which is exactly the sort of quiet damage a
 * deploy should not be able to do.
 */
function fromEnv(): Partial<Settings> {
  const patch: Partial<Settings> = {};
  const entity = process.env.ENTITY_NAME?.trim();
  const taxId = process.env.ENTITY_TAX_ID?.trim();
  const preparerEmail = process.env.PREPARER_EMAIL?.trim().toLowerCase();
  const taxManagerEmail = process.env.TAX_MANAGER_EMAIL?.trim().toLowerCase();
  const driveFolderId = process.env.DRIVE_FOLDER_ID?.trim();
  const gmailQuery = process.env.GMAIL_QUERY?.trim();

  if (entity) patch.entity = entity;
  if (taxId) patch.entityTaxId = taxId;
  if (preparerEmail) patch.preparerEmail = preparerEmail;
  if (taxManagerEmail) patch.taxManagerEmail = taxManagerEmail;
  if (driveFolderId) patch.driveFolderId = driveFolderId;
  if (gmailQuery) patch.gmailQuery = gmailQuery;
  return patch;
}

/** Spread-safe: a key set to `undefined` must not shadow the layer beneath it. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export async function getSettings(): Promise<Settings> {
  const stored = await readStore<Partial<Settings>>("settings", {});
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...fromEnv(),
    ...defined(stored),
  };

  // A settings file with no periods leaves every panel with nothing to scope
  // to, and every count reading zero for the wrong reason. Fall back to the
  // shipped period rather than hand back an empty list.
  if (!Array.isArray(merged.periods) || merged.periods.length === 0) {
    merged.periods = DEFAULT_SETTINGS.periods;
  }
  return merged;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalise({ ...(await getSettings()), ...defined(patch) });
  await writeStore("settings", next);
  return next;
}

/**
 * Coerce the numeric settings back into range.
 *
 * `reviewConfidence` is the one that bites: typed as `75` rather than `0.75` it
 * clamps to 1 and every classification is flagged. That is loud and obviously
 * wrong, which is the safe direction for a mistyped threshold — the other
 * direction flags nothing and looks like a clean quarter.
 */
function normalise(settings: Settings): Settings {
  const positive = (value: number, fallback: number) =>
    Number.isFinite(value) && value >= 0 ? value : fallback;

  return {
    ...settings,
    entity: settings.entity.trim() || DEFAULT_SETTINGS.entity,
    currency: (settings.currency || DEFAULT_SETTINGS.currency).trim().toUpperCase(),
    preparerEmail: settings.preparerEmail.trim().toLowerCase(),
    taxManagerEmail: settings.taxManagerEmail.trim().toLowerCase(),
    reviewConfidence: Math.min(
      1,
      Math.max(0, positive(Number(settings.reviewConfidence), DEFAULT_SETTINGS.reviewConfidence)),
    ),
    capitalisationThreshold: positive(
      Number(settings.capitalisationThreshold),
      DEFAULT_SETTINGS.capitalisationThreshold,
    ),
    contractor1099Threshold: positive(
      Number(settings.contractor1099Threshold),
      DEFAULT_SETTINGS.contractor1099Threshold,
    ),
    recurrenceGapMonths: positive(
      Number(settings.recurrenceGapMonths),
      DEFAULT_SETTINGS.recurrenceGapMonths,
    ),
  };
}

/**
 * The period the console is working on.
 *
 * Falls back to the first period on file when `activePeriodId` names one that
 * is not there. That state is a settings error, but returning nothing would
 * make every panel and every route throw at once, which describes the fault far
 * less usefully than a console showing the wrong quarter's label does.
 */
export async function activePeriod(): Promise<FilingPeriod> {
  const settings = await getSettings();
  return (
    settings.periods.find((period) => period.id === settings.activePeriodId) ??
    settings.periods[0] ??
    Q1_2025
  );
}

export async function getPeriod(id: string): Promise<FilingPeriod | undefined> {
  return (await getSettings()).periods.find((period) => period.id === id);
}

/**
 * Who this app acts as.
 *
 * There is no sign-in, so every audit row is attributed to one configured
 * address. Read from the environment on each call rather than from stored
 * settings: the identity an action is recorded under is a deployment fact, and
 * it should not be editable from inside the console it is auditing.
 */
export function preparer(): string {
  return process.env.PREPARER_EMAIL?.trim().toLowerCase() || DEFAULT_SETTINGS.preparerEmail;
}

/** False when the audit trail is naming the placeholder rather than a person. */
export function preparerConfigured(): boolean {
  return Boolean(process.env.PREPARER_EMAIL?.trim());
}

/**
 * Who the finished package goes to.
 *
 * Must not be the preparer. This module does not enforce that — the handoff
 * route does, where there is a person to tell — but the two addresses are read
 * through separate functions so nothing can accidentally treat them as one.
 */
export function taxManager(): string {
  return process.env.TAX_MANAGER_EMAIL?.trim().toLowerCase() || DEFAULT_SETTINGS.taxManagerEmail;
}

export function taxManagerConfigured(): boolean {
  return Boolean(process.env.TAX_MANAGER_EMAIL?.trim());
}

/**
 * The tone block appended to a drafting prompt.
 *
 * Empty when no house style is set. An empty string is appended to nothing;
 * inventing a default voice here would put words the operator never chose into
 * an email that goes out over their name.
 */
export function voicePrompt(s: Settings): string {
  const voice = s.voice.trim();
  if (!voice) return "";
  return [
    `House style: ${voice}`,
    `Entity: ${s.entity}. Figures are in ${s.currency}, ${s.basis} basis.`,
  ].join("\n");
}

/**
 * The entity's tax id, masked.
 *
 * There is no unmasked accessor and this never returns the full number, not
 * even when the stored value is short: a four-digit id shown as its last four
 * digits is the whole id. An employer identification number on a screen share
 * or in a screenshot is the failure this prevents, and it is not worth the
 * convenience of an "unmask" toggle.
 *
 * An em dash for an unset id, matching what the console shows for every other
 * figure it does not have.
 */
export function maskTaxId(value?: string): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "—";
  if (digits.length <= 4) return "••-•••••";
  return `••-•••${digits.slice(-4)}`;
}

/**
 * Whether a date falls inside the period, inclusive of both ends.
 *
 * Compared as strings. Both sides are ISO `YYYY-MM-DD`, which sorts correctly
 * lexicographically, and parsing them into `Date` would drag a timezone into a
 * question that has none — a receipt dated 2025-01-01 must not fall out of the
 * quarter because the server runs in UTC-5.
 *
 * An absent date is not in the period. It is also not *out* of it: a caller
 * raising `out-of-period` has to check for a date first, or every unreadable
 * scan gets flagged for the wrong reason.
 */
export function inPeriod(date: string | undefined, period: FilingPeriod): boolean {
  if (!date) return false;
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day >= period.start && day <= period.end;
}

/**
 * One money formatter, used everywhere a figure is shown.
 *
 * The locale is pinned rather than taken from the server, so the same figure
 * reads identically for every reviewer and matches the US federal forms these
 * drafts map onto. An unknown currency code makes `Intl` throw, and a document
 * that arrived in a currency nobody recognised must still show its figure —
 * flagging it is the exception engine's job, hiding it behind a crash is
 * nobody's.
 */
export function money(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return "—";
  const code = (currency || "USD").trim().toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}
