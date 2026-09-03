#!/usr/bin/env node
/**
 * Load the generated corpus into `.data/` so the console has something real to
 * work on.
 *
 *   node scripts/seed.mjs           # refuses if documents.json already has rows
 *   node scripts/seed.mjs --force   # replaces the register and the files
 *
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

  console.log(`Wrote .data/settings.json — ${manifest.period.label}, ${manifest.entity}, ${manifest.period.currency}, cash basis.`);
  console.log(`Wrote .data/documents.json — ${documents.length} document(s).`);
  console.log(`Copied ${documents.length} PDF(s) to .data/documents/<id>.pdf with a computed sha256.`);
  console.log(`Appended one audit row: corpus.seed.`);
  console.log(`Sources: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")}.`);

  if (hashProblems.length) {
    console.error("\nHash mismatches against the manifest:");
    for (const problem of hashProblems) console.error(`  ${problem}`);
    console.error("Re-run `npm run fixtures`; the corpus on disk is not the one the manifest describes.");
    process.exitCode = 1;
  }
  console.log(
    "\nNo extractions, categorisations or exceptions were written. Nothing has been read off " +
      "these documents yet — run the period from the Workspace screen, and the findings will be " +
      "ones a model and a rule actually produced.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
