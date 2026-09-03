#!/usr/bin/env node
/**
 * Load the generated corpus into `.data/` so the console has something real to
 * work on.
 *
 *   node scripts/seed.mjs           # refuses if documents.json already has rows
 *   node scripts/seed.mjs --force   # replaces the register and the files
 *
 * It seeds **documents, the ledger and the filing period, and nothing else.**
 *
 * Not extractions. An extraction is a figure a model read off a page, and a
 * seeded one would put a number in the register that no model ever read —
 * indistinguishable, three screens later, from one that was. The whole product
 * is a chain from a document to a form line, and a fabricated link in it is
 * worse than a missing one because nobody can see it is missing.
 *
 * Not classifications, for the same reason, and not exceptions: `detect` owns
 * their lifecycle and their resolution notes.
 *
 * Not audit rows. The trail is append-only and its value is entirely that
 * every row in it happened. Writing "extracted 39 documents" for work that was
 * never done makes the trail a story rather than a record, and there is no way
 * to tell afterwards which rows were real. The seeder appends one row, for the
 * thing it actually did.
 *
 * Plain node, no imports from `src/`: those modules are TypeScript and start
 * with `server-only`, which is a build-time marker the Next compiler resolves
 * and node does not. The shapes written here are the ones in `src/lib/types.ts`
 * and the collection names are the ones in `src/lib/store.ts`; when either
 * changes, this file changes with it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures");
const DATA = path.join(ROOT, ".data");
const DOCS_DIR = path.join(DATA, "documents");

const force = process.argv.includes("--force");

/* ────────────────────────────────────────────────────────────────────────────
 * Store helpers — the same two operations `src/lib/store.ts` exposes
 * ────────────────────────────────────────────────────────────────────────── */

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, `${name}.json`), "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Write through a temp file and a rename, exactly as the app does.
 *
 * A seeder killed halfway through writing `documents.json` would otherwise
 * leave a truncated register that parses as an empty array, and the next run
 * would decide there was nothing there and quietly overwrite the rest.
 */
async function writeJson(name, value) {
  await mkdir(DATA, { recursive: true });
  const target = path.join(DATA, `${name}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, target);
}

/* ────────────────────────────────────────────────────────────────────────────
 * CSV
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * RFC 4180 by hand: quoted fields, embedded commas, doubled quotes, CRLF.
 *
 * The app has its own parser in `src/lib/ledger.ts`; this is a second one
 * because the seeder cannot import it. They must agree, and the corpus
 * deliberately contains a field with a comma and one with doubled quotes so a
 * disagreement shows up here rather than as two ledgers that differ by a row.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      /* Swallowed; the \n that follows ends the row. */
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline produces one empty row; drop it rather than importing a
  // ledger entry with no date, which would then be flagged as missing support.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Documents
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The same cheap page count `src/lib/documents.ts` uses, and the same refusal
 * to guess: zero matches means "we did not manage to count", which is not the
 * same statement as "this file has no pages".
 */
function countPages(bytes) {
  const markers = bytes.toString("latin1").match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const count = markers?.length ?? 0;
  return count === 0 || count > 5000 ? undefined : count;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Settings
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The smallest settings file that makes the corpus openable.
 *
 * Only the filing period and the entity it belongs to. Thresholds, the review
 * confidence, the preparer and tax manager addresses and the voice are
 * deliberately left out: `getSettings` layers stored settings *above* the
 * environment, so a value written here that nobody chose would shadow the
 * deployment's own configuration on every future boot, silently. The entity
 * name and tax id are written only when the environment has not already said
 * what they are, for the same reason.
 */
function buildSettings(manifest) {
  const period = {
    id: manifest.period.id,
    label: manifest.period.label,
    entity: manifest.entity,
    start: manifest.period.start,
    end: manifest.period.end,
    jurisdiction: "US-federal",
    basis: "cash",
    currency: manifest.period.currency,
    status: "open",
  };

  const settings = { activePeriodId: period.id, periods: [period] };
  if (!process.env.ENTITY_NAME?.trim()) settings.entity = manifest.entity;
  if (!process.env.ENTITY_TAX_ID?.trim() && manifest.entityTaxId) {
    settings.entityTaxId = manifest.entityTaxId;
  }
  return settings;
}

function preparer() {
  return (
    process.env.PREPARER_EMAIL?.trim().toLowerCase() ||
    "tax-document-preparation-assistant@new-digital-intelligence.com"
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main
 * ────────────────────────────────────────────────────────────────────────── */

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(FIXTURES, "manifest.json"), "utf8"));
  } catch {
    throw new Error(
      "No fixtures/manifest.json. Run `npm run fixtures` first — the seeder loads the " +
        "generated corpus, it does not invent one.",
    );
  }

  const existing = await readJson("documents", []);
  if (!force && Array.isArray(existing) && existing.length) {
    console.log(
      `.data/documents.json already holds ${existing.length} document(s). ` +
        "Re-run with --force to replace them.",
    );
    console.log(
      "\nForce replaces the register rows and the files under .data/documents. It does not " +
        "touch the audit trail, and it does not touch exception resolutions — those are " +
        "records of what a person decided, not corpus data.",
    );
    return;
  }

  const actor = preparer();
  const periodId = manifest.period.id;
  const started = Date.now();

  /* ── The files and the register ────────────────────────────────────────── */

  await mkdir(DOCS_DIR, { recursive: true });
  if (force) {
    // Only the fixture ids, so a document someone uploaded by hand into a
    // seeded workspace is not swept away by a re-seed of the corpus.
    const seeded = new Set(manifest.documents.map((entry) => `${entry.id}.pdf`));
    for (const name of await readdir(DOCS_DIR).catch(() => [])) {
      if (seeded.has(name)) await rm(path.join(DOCS_DIR, name), { force: true });
    }
  }

  const documents = [];
  const hashProblems = [];

  for (const [index, entry] of manifest.documents.entries()) {
    const bytes = await readFile(path.join(FIXTURES, "documents", entry.file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // The manifest records the hash the generator produced. A mismatch means
    // the file on disk is not the file the expected findings were written
    // against, and the duplicate fixture in particular stops being a duplicate.
    if (entry.sha256 && entry.sha256 !== sha256) {
      hashProblems.push(
        `${entry.file}: manifest says ${entry.sha256.slice(0, 12)}, file hashes to ${sha256.slice(0, 12)}`,
      );
    }

    await writeFile(path.join(DOCS_DIR, `${entry.id}.pdf`), bytes);

    documents.push({
      id: entry.id,
      periodId,
      filename: entry.file,
      source: entry.source,
      sourceRef: entry.sourceRef,
      sourceDetail: entry.sourceDetail,
      mimeType: entry.mimeType ?? "application/pdf",
      bytes: bytes.byteLength,
      pageCount: countPages(bytes),
      sha256,
      storagePath: `documents/${entry.id}.pdf`,
      // One second apart, in manifest order. `listDocuments` sorts on this, so
      // spacing them keeps the documents tab and the package index in corpus
      // order instead of whatever order the loop happened to finish in.
      ingestedAt: new Date(started + index * 1000).toISOString(),
      ingestedBy: actor,
    });
  }

  await writeJson("documents", documents);

  /* ── The ledger ────────────────────────────────────────────────────────── */

  const csv = await readFile(path.join(FIXTURES, manifest.ledgerFile), "utf8");
  const rows = parseCsv(csv);
  const header = rows.shift()?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const column = (name) => header.indexOf(name);

  const REQUIRED = ["date", "description", "counterparty", "amount", "currency", "account"];
  const missing = REQUIRED.filter((name) => column(name) === -1);
  if (missing.length) {
    throw new Error(
      `${manifest.ledgerFile} is missing the column(s) ${missing.join(", ")}. ` +
        "Columns are found by name, never by position.",
    );
  }

  const importedAt = new Date(started).toISOString();
  const ledger = [];
  const ledgerProblems = [];

  rows.forEach((cells, i) => {
    const line = i + 2; // header is line 1
    const date = (cells[column("date")] ?? "").trim();
    const amount = Number((cells[column("amount")] ?? "").trim().replace(/[$,]/g, ""));

    // A row that cannot be parsed is reported with its line number, never
    // dropped in silence: a ledger quietly one row short reconciles cleanly and
    // hides the transaction that had no support.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ledgerProblems.push(`line ${line}: "${date}" is not an ISO date`);
      return;
    }
    if (!Number.isFinite(amount)) {
      ledgerProblems.push(`line ${line}: amount "${cells[column("amount")]}" is not a number`);
      return;
    }

    ledger.push({
      id: `led_${String(ledger.length + 1).padStart(3, "0")}`,
      periodId,
      date,
      description: (cells[column("description")] ?? "").trim(),
      counterparty: (cells[column("counterparty")] ?? "").trim(),
      amount,
      currency: ((cells[column("currency")] ?? "USD").trim() || "USD").toUpperCase(),
      account: (cells[column("account")] ?? "").trim(),
      ref: column("ref") === -1 ? undefined : (cells[column("ref")] ?? "").trim() || undefined,
      source: "csv",
      importedAt,
    });
  });

  await writeJson("ledger", ledger);

  /* ── Settings ──────────────────────────────────────────────────────────── */

  const settings = buildSettings(manifest);
  await writeJson("settings", settings);

  /* ── The one audit row that actually happened ──────────────────────────── */

  const trail = await readJson("audit", []);
  await writeJson("audit", [
    {
      id: `aud_seed_${started.toString(36)}`,
      at: new Date(started).toISOString(),
      actor,
      action: "corpus.seed",
      subject: periodId,
      result: "ok",
      detail:
        `Seeded ${documents.length} document(s) and ${ledger.length} ledger row(s) for ` +
        `${manifest.period.label} from fixtures/manifest.json` +
        `${force ? ", replacing the previous register (--force)" : ""}. ` +
        "No extraction, categorisation or exception was written: nothing has been read off " +
        "these documents yet.",
      periodId,
    },
    ...(Array.isArray(trail) ? trail : []),
  ]);

  /* ── Report ────────────────────────────────────────────────────────────── */

  const bySource = {};
  for (const doc of documents) bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;
  const money = ledger.reduce((sum, row) => sum + Math.abs(row.amount), 0);

  console.log(`Wrote .data/settings.json — ${manifest.period.label}, ${manifest.entity}, ${manifest.period.currency}, cash basis.`);
  console.log(`Wrote .data/documents.json — ${documents.length} document(s).`);
  console.log(`Copied ${documents.length} PDF(s) to .data/documents/<id>.pdf with a computed sha256.`);
  console.log(`Wrote .data/ledger.json — ${ledger.length} row(s), ${money.toFixed(2)} of gross movement.`);
  console.log(`Appended one audit row: corpus.seed.`);
  console.log(`Sources: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")}.`);

  if (hashProblems.length) {
    console.error("\nHash mismatches against the manifest:");
    for (const problem of hashProblems) console.error(`  ${problem}`);
    console.error("Re-run `npm run fixtures`; the corpus on disk is not the one the manifest describes.");
    process.exitCode = 1;
  }
  if (ledgerProblems.length) {
    console.error(`\n${ledgerProblems.length} ledger row(s) could not be imported:`);
    for (const problem of ledgerProblems) console.error(`  ${problem}`);
    process.exitCode = 1;
  }

  console.log(
    "\nNo extractions, categorisations, matches or exceptions were written. Nothing has been " +
      "read off these documents yet — run extraction from the console, then categorisation, " +
      "then reconciliation, and the findings will be ones a model and a rule actually produced.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
