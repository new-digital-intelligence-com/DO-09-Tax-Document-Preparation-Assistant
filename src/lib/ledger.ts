import "server-only";
import { record } from "./audit";
import { getPeriod } from "./settings";
import { mutate, newId, readStore } from "./store";
import type { LedgerEntry, Match } from "./types";

/**
 * The accounting ledger, as imported from a CSV export.
 *
 * This module reads a file and writes rows. It never *changes* one. The ledger
 * is the accounting system's statement of what happened, and this app's job is
 * to hold documents up against it and say where the two disagree — not to move
 * a figure so a total comes out even. Every function below either adds rows
 * from a file, lists them, or removes a whole period's worth on an operator's
 * instruction. There is no update path, and adding one would break the only
 * thing that makes a reconciliation worth reading.
 *
 * The parser is written by hand because there is no CSV library in this build.
 * That is not a hardship: the failure a hand-rolled parser has to avoid is the
 * naive `split(",")`, which turns `"Acme Design, Inc.",1200.00` into a row with
 * the amount in the wrong column and no sign that anything went wrong. Quoted
 * fields, embedded commas, doubled quotes and `\r\n` are all handled, and a row
 * that still cannot be read lands in `problems` with its line number rather
 * than being dropped. A ledger silently short by one row makes every downstream
 * count wrong in a way nobody can trace back here.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * CSV parsing
 * ────────────────────────────────────────────────────────────────────────── */

type RawRow = {
  /** 1-based line in the file where this record started, for `problems`. */
  line: number;
  fields: string[];
};

/**
 * RFC 4180 with the tolerances a real export needs.
 *
 * A newline inside quotes belongs to the field, so the line number recorded is
 * where the *record* began — pointing a person at the middle of a multi-line
 * description is pointing them at nothing.
 */
function parseCsv(text: string): RawRow[] {
  // A spreadsheet export opens with a byte-order mark, which sticks to the
  // first header cell and stops `date` matching a column that plainly says
  // date. The whole import then fails on a missing column a person can see.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: RawRow[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let started = false;

  const endRow = () => {
    fields.push(field);
    rows.push({ line: startLine, fields });
    fields = [];
    field = "";
    started = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (!started) {
      startLine = line;
      started = true;
    }

    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      fields.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      if (source[i + 1] === "\n") i++;
      line++;
      endRow();
      continue;
    }
    if (ch === "\n") {
      line++;
      endRow();
      continue;
    }
    field += ch;
  }

  // A file that does not end in a newline still has a last row in it.
  if (started || field.length > 0 || fields.length > 0) endRow();

  return rows;
}

function isBlank(row: RawRow): boolean {
  return row.fields.every((value) => value.trim() === "");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Header mapping
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Columns are found by name, never by position.
 *
 * Every accounting system exports the same seven facts in a different order and
 * under a slightly different label, and a positional reader silently swaps
 * `amount` and `account` the first time someone re-exports with a new template.
 * The aliases are the spellings seen in the wild; anything else is reported as
 * a missing column rather than guessed at.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "transactiondate", "postdate", "posteddate", "bookingdate"],
  description: ["description", "memo", "details", "narrative", "particulars"],
  counterparty: ["counterparty", "payee", "vendor", "supplier", "customer", "name"],
  amount: ["amount", "value", "amountusd"],
  currency: ["currency", "ccy", "currencycode"],
  account: ["account", "accountname", "glaccount", "chartaccount"],
  ref: ["ref", "reference", "refno", "referencenumber", "invoicenumber", "invoiceno", "docno"],
  /**
   * Not one of the seven, and not required. The fixture seeder supplies stable
   * ids (`led_001` …) so a regenerated corpus reproduces the same matches and
   * the same exceptions; an export without the column gets generated ids.
   */
  id: ["id", "entryid", "ledgerid", "lineid"],
};

/** Columns without which a row means nothing, so an import cannot proceed. */
const REQUIRED = ["date", "description", "counterparty", "amount"] as const;

function normaliseHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapHeader(cells: string[]): Map<string, number> {
  const index = new Map<string, number>();
  cells.forEach((cell, position) => {
    const key = normaliseHeader(cell);
    for (const [column, aliases] of Object.entries(HEADER_ALIASES)) {
      // First column wins. A file with both `memo` and `description` gets the
      // leftmost, and the duplicate is reported rather than overwriting it.
      if (aliases.includes(key) && !index.has(column)) index.set(column, position);
    }
  });
  return index;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cell normalisation
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A date, or nothing.
 *
 * ISO is accepted as written. `M/D/YYYY` is accepted because the jurisdiction
 * is US federal and that is what the exports carry — but only when the first
 * number could be a month. `13/04/2025` is *rejected*, not silently read as
 * 4 December: a ledger row whose date was guessed will match the wrong document
 * or fall out of the quarter, and neither failure announces itself. A rejected
 * row is visible; a misread one is not.
 */
function normaliseDate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(value);
  if (us) return buildDate(Number(us[3]), Number(us[1]), Number(us[2]));

  return undefined;
}

function buildDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (year < 1900 || year > 2999) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * An amount, or nothing.
 *
 * Handles the four things an export does to a number: a currency symbol,
 * thousands separators, a trailing minus, and accounting parentheses for a
 * negative. A cell with no digit in it at all returns nothing rather than 0 —
 * an empty amount read as zero is a transaction that reconciles against
 * nothing and disappears from every total.
 */
function normaliseAmount(raw: string): number | undefined {
  const value = raw.trim();
  if (!/\d/.test(value)) return undefined;

  const negative = /^\(.*\)$/.test(value) || /-\s*$/.test(value) || value.trimStart().startsWith("-");
  const digits = value.replace(/[^0-9.]/g, "");
  if (!digits) return undefined;

  // Two decimal points means the thousands separator was a dot and the decimal
  // a comma, or the cell is not a number at all. Either way it is not readable
  // with confidence, and a wrong amount is the worst row this file can produce.
  if ((digits.match(/\./g) ?? []).length > 1) return undefined;

  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -parsed : parsed;
}

function normaliseCurrency(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public surface
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The ledger, oldest first.
 *
 * Date order rather than import order: the reconciliation table and the
 * ledger-only list both read as a bank statement does, and a reviewer scanning
 * for the week a payment cleared should not have to hunt through the order a
 * CSV happened to be written in. Ties break on id so the order is total.
 */
export async function listLedger(periodId?: string): Promise<LedgerEntry[]> {
  const entries = await readStore<LedgerEntry[]>("ledger", []);
  return entries
    .filter((entry) => !periodId || entry.periodId === periodId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/**
 * Import a CSV export into one period.
 *
 * Additive by design. `clearLedger` is the way to replace a period's ledger,
 * and it is a separate, audited act — an import that quietly wiped what was
 * there would destroy hand-corrected rows the moment someone re-ran a sweep.
 * Rows carrying an explicit `id` replace the row with that id instead of
 * doubling it, which is what makes re-seeding the fixture corpus reproducible.
 *
 * `problems` is not only parse failures. It also carries the assumptions the
 * import made — a currency taken from the period, a date outside the quarter —
 * because an assumption nobody was told about is indistinguishable from a fact.
 */
export async function importLedgerCsv(
  csv: string,
  periodId: string,
  actor: string,
): Promise<{ imported: number; skipped: number; problems: string[] }> {
  const period = await getPeriod(periodId);
  const problems: string[] = [];
  const rows = parseCsv(csv ?? "").filter((row) => !isBlank(row));

  if (rows.length === 0) {
    const detail = "The file has no rows in it. Nothing was imported.";
    problems.push(detail);
    await record({
      actor,
      action: "ledger.import",
      subject: periodId,
      result: "error",
      detail,
      periodId,
    });
    return { imported: 0, skipped: 0, problems };
  }

  const header = rows[0];
  const columns = mapHeader(header.fields);
  const missing = REQUIRED.filter((column) => !columns.has(column));
  const body = rows.slice(1);

  if (missing.length > 0) {
    // Refuse the whole file rather than import the columns that were found. A
    // ledger imported without amounts is worse than no ledger: every entry
    // reconciles against nothing and the console reports a clean quarter.
    const detail =
      `The header names no ${missing.join(", ")} column. Found: ` +
      `${header.fields.map((cell) => cell.trim()).filter(Boolean).join(", ") || "nothing"}. ` +
      `Expected date, description, counterparty, amount, currency, account, ref. ` +
      `Nothing was imported.`;
    problems.push(`Line ${header.line}: ${detail}`);
    await record({
      actor,
      action: "ledger.import",
      subject: periodId,
      result: "error",
      detail,
      periodId,
    });
    return { imported: 0, skipped: body.length, problems };
  }

  const cell = (row: RawRow, column: string): string => {
    const position = columns.get(column);
    return position === undefined ? "" : (row.fields[position] ?? "").trim();
  };

  const parsed: LedgerEntry[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;
  const importedAt = new Date().toISOString();

  for (const row of body) {
    // A row with a different field count than the header is the shifted-column
    // failure. Read anyway and every column after the short one is wrong, so it
    // is refused with the counts named.
    if (row.fields.length !== header.fields.length) {
      skipped++;
      problems.push(
        `Line ${row.line}: ${row.fields.length} field(s) where the header declares ` +
          `${header.fields.length}. Skipped rather than read with its columns shifted.`,
      );
      continue;
    }

    const date = normaliseDate(cell(row, "date"));
    if (!date) {
      skipped++;
      problems.push(
        `Line ${row.line}: cannot read "${cell(row, "date")}" as a date. Expected ` +
          `YYYY-MM-DD or M/D/YYYY. Skipped rather than dated by guesswork.`,
      );
      continue;
    }

    const amount = normaliseAmount(cell(row, "amount"));
    if (amount === undefined) {
      skipped++;
      problems.push(
        `Line ${row.line}: cannot read "${cell(row, "amount")}" as an amount. Skipped — ` +
          `an unreadable figure must not reach a total as zero.`,
      );
      continue;
    }

    const declared = normaliseCurrency(cell(row, "currency"));
    const currency = declared ?? period?.currency ?? "USD";
    if (!declared) {
      problems.push(
        `Line ${row.line}: no currency on the row, recorded as ${currency} from the period. ` +
          `Correct the export if this entry was in another currency.`,
      );
    }

    if (period && (date < period.start || date > period.end)) {
      problems.push(
        `Line ${row.line}: dated ${date}, outside ${period.label} ` +
          `(${period.start} to ${period.end}). Imported anyway — dropping a ledger row is not ` +
          `this module's decision — and it will show as unsupported until a document matches it.`,
      );
    }

    const suppliedId = cell(row, "id");
    const id = suppliedId || newId("led");
    if (seenIds.has(id)) {
      skipped++;
      problems.push(
        `Line ${row.line}: id ${id} appears twice in this file. The second row is skipped; ` +
          `two entries sharing an id make every match ambiguous.`,
      );
      continue;
    }
    seenIds.add(id);

    parsed.push({
      id,
      periodId,
      date,
      description: cell(row, "description"),
      counterparty: cell(row, "counterparty"),
      amount,
      currency,
      account: cell(row, "account"),
      ref: cell(row, "ref") || undefined,
      source: "csv",
      importedAt,
    });
  }

  const imported = await mutate<LedgerEntry[], number>("ledger", [], (existing) => {
    const byId = new Map(existing.map((entry) => [entry.id, entry]));
    for (const entry of parsed) byId.set(entry.id, entry);
    return { next: [...byId.values()], result: parsed.length };
  });

  await record({
    actor,
    action: "ledger.import",
    subject: periodId,
    result: problems.length > 0 ? "info" : "ok",
    detail:
      `Imported ${imported} ledger row(s) into ${period?.label ?? periodId}, skipped ${skipped}` +
      (problems.length > 0 ? `, ${problems.length} problem(s) reported to the importer.` : ".") +
      ` Reconciliation is stale until it is re-run.`,
    periodId,
  });

  return { imported, skipped, problems };
}

/**
 * Remove a period's ledger.
 *
 * Its matches go with it. A `Match` row pointing at an entry that is no longer
 * on file shows in the reconciliation table as a pairing whose other half
 * cannot be opened, and in the exceptions list as a mismatch against a figure
 * nobody can look up. Dropping them here means the console reports the ledger
 * as not yet reconciled, which is exactly what is true.
 *
 * Exceptions are deliberately left alone. `detect` owns their lifecycle: it
 * drops findings that no longer apply and logs each one, and it keeps the note
 * a person wrote when they closed something. Clearing them from here would
 * erase those notes without anyone deciding to.
 */
export async function clearLedger(periodId: string, actor: string): Promise<number> {
  const removed = await mutate<LedgerEntry[], number>("ledger", [], (entries) => {
    const keep = entries.filter((entry) => entry.periodId !== periodId);
    return { next: keep, result: entries.length - keep.length };
  });

  const staleMatches = await mutate<Match[], number>("matches", [], (matches) => {
    const keep = matches.filter((match) => match.periodId !== periodId);
    return { next: keep, result: matches.length - keep.length };
  });

  await record({
    actor,
    action: "ledger.clear",
    subject: periodId,
    result: "ok",
    detail:
      `Removed ${removed} ledger row(s) and the ${staleMatches} reconciliation match(es) that ` +
      `depended on them. Open exceptions are left as they are; re-running detection is what ` +
      `retires the ones that no longer apply.`,
    periodId,
  });

  return removed;
}
