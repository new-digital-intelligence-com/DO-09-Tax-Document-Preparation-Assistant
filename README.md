# DO-09 — Tax Document Preparation Assistant

Collect invoices, receipts and financial documents, sort them by tax category,
pre-fill draft tax forms, flag every inconsistency for a human, and assemble a
review-ready package.

**Nothing here files anything.** Every form this repo produces is a draft, and
`FormDraft.status` has exactly one possible value. A tax manager reviews the
pack and files it. That is enforced in code — there is no submit path, in the
UI, in the HTTP API, or in the AI's toolset — and the section on
[the three invariants](#the-three-invariants) traces exactly where.

There are two surfaces and they share one behaviour contract:

| Surface | What runs it | Needs |
|---|---|---|
| The `do-09-tax-prep` skill, in Claude Code or the Claude app | Claude itself | The Google Drive and Gmail connectors |
| The Next.js console at `localhost:3000` | Claude Haiku 4.5 via the Anthropic API | `.env.local` |

---

## Where this build is

This is the **first stage**, and it is deliberately offline.

- **No connectors are wired into the web app.** The document corpus is
  generated: 30-odd realistic PDFs for a fictional studio's 2025 Q1, built by
  `npm run fixtures` with no network and no dependencies.
- **Everything downstream of collection is real.** Extraction, categorisation,
  reconciliation against a ledger, the exception engine, the draft forms and
  the review package all run for real against that corpus, and against
  anything you upload.
- **There is no sign-in.** Every action is attributed to `PREPARER_EMAIL`. Put
  real authentication in front of this before it leaves your machine.
- **Google Drive and Gmail come next.** The collection sweep is the only piece
  the fixtures stand in for. The skill already describes both connectors and
  uses them when they are attached; see
  [`references/connectors.md`](plugins/do-09-tax-prep/skills/do-09-tax-prep/references/connectors.md).

The corpus is not decoration. It is the test suite: every exception kind in
`src/lib/types.ts` is reachable from it, the expected findings are written into
`fixtures/manifest.json`, and `npm run smoke` asserts them.

---

## Setup — pick your path

### Path A · Claude — no credentials, no `.env`, no Node

The plugin is instructions only. Claude is the model, and the connectors are
already in your client.

1. Add this repo as a plugin marketplace and install the plugin:

   ```
   /plugin marketplace add <this repo>
   /plugin install do-09-tax-prep@ndi-tax
   ```

2. Enable the **Google Drive** and **Gmail** connectors in your client.

3. Trigger it by name — there is no slash command:

   ```
   use the do-09-tax-prep skill
   do-09-tax-prep: start the Q1 prep for Northwind Studio
   do-09-tax-prep: which ledger entries have no supporting document
   do-09-tax-prep: what is flagged high before I hand this to the accountant
   ```

   It checks both connectors are present and stops plainly if one is missing —
   a confident answer about a filing period, assembled from nothing, is worse
   than no answer.

### Path B · The web app

```bash
cp .env.example .env.local     # fill it in, see below
npm install
npm run fixtures               # generate the mock document corpus
npm run seed                   # load it into .data/
npm run dev
```

Then open `http://localhost:3000`.

With the server up, `npm run smoke` runs the whole pipeline end to end and
checks the results against the corpus's known truth.

### What `.env.local` needs

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY` | Extraction, categorisation, the chat panel and the drafting helpers. Without it the app runs and says so; it does not pretend the documents were read. |
| `ANTHROPIC_MODEL` | Defaults to `claude-haiku-4-5`. |
| `PREPARER_EMAIL` | Who the app acts as. Every audit entry is attributed to it. |
| `TAX_MANAGER_EMAIL` | Who the package goes to. Must not be the preparer — a second person reviewing it is the point. |

---

## The three invariants

Everything in this repo is downstream of three rules. They are shared verbatim
between the plugin and the web app: the skill loads
[`references/rules.md`](plugins/do-09-tax-prep/skills/do-09-tax-prep/references/rules.md),
and `src/lib/skills.ts` reads that same file into the app agent's system prompt,
so a rule changed once applies to both.

### 1 · Nothing is filed

There is no e-file path, no submit button, and no `file_return` tool. Every
form carries the same disclaimer and the same word: DRAFT.

`FormDraft.status` is typed as the literal `"draft"`. There is no code path in
this repo that sets it to anything else, which is a stronger guarantee than any
sentence in a prompt.

### 2 · Flag, never fix silently

When a document says `$1,842.19` and the ledger says `$1,824.19`, the app
raises a `ledger-amount-mismatch` naming both figures and the $18.00 delta. It
does not adjust either one, and nothing in the codebase writes to a
`LedgerEntry`. A reconciliation that silently agrees with itself is the failure
this product exists to prevent — the discrepancy was the finding.

Exceptions are idempotent: re-running detection keeps the note a human wrote on
a finding that still applies, and drops findings that no longer do, logging that
it dropped them. A stale flag nobody can clear teaches reviewers to ignore the
list.

### 3 · No tax advice

Some categories are judgement calls by their nature, and the chart says which:
`TaxCategory.alwaysReview` forces a flag regardless of how confident the model
is. A $2,899 laptop is not an expense, it is a depreciation question. A phone
bill is part personal. Health premiums are not on this form at all. The
assistant routes those with the document attached; it does not decide them.

The confidence score is about reading the page, not about the answer being
right. Those are different things and the UI keeps them apart.

---

## The pipeline

```
collect → extract → categorise → reconcile → flag → draft → package → hand off
```

| Step | What runs | Where |
|---|---|---|
| **Collect** | Fixtures now; Drive + Gmail sweep next. Hash on the way in, but a duplicate is still ingested — deduplicating on arrival hides that the same invoice came twice, which is itself a finding. | `src/lib/documents.ts` |
| **Extract** | One Claude call per document, the PDF sent as a `document` block. `unreadable` is a first-class answer, not an error. | `src/lib/extract.ts` |
| **Categorise** | Batched against the chart in `src/lib/categories.ts`, with a confidence and a rationale on every one. | `src/lib/classify.ts` |
| **Reconcile** | Deterministic matching against the ledger — no model. A pairing a model made up is a pairing nobody can check. | `src/lib/reconcile.ts` |
| **Flag** | Sixteen exception kinds, each with a severity, the actual figures, and an action a person can take. | `src/lib/exceptions.ts` |
| **Draft** | Schedule C, a 1099-NEC summary and a 1040-ES worksheet. Arithmetic only — a total a model computed is a total nobody can check. | `src/lib/forms.ts` |
| **Package** | Sorted index, drafts, reconciliation summary and open items, as markdown. Leads with the open items, not the totals. | `src/lib/packages.ts` |
| **Hand off** | Records the intent and hands the reviewer something to send. It does not send mail, and it does not file. | `src/lib/packages.ts` |

### Why no PDF library

The app sends the file itself to the model rather than parsing a text layer. A
text extractor reads a born-digital invoice perfectly and returns *nothing at
all* for a scan — and "nothing" is the one result that must never be mistaken
for "no expenses". Sending the page means a scan is read the way a person reads
it, and a genuinely illegible one comes back marked `unreadable` and lands in
the exceptions list with its filename, rather than quietly leaving the corpus so
the counts look clean.

The generated corpus includes one image-only page with no text operators at all,
precisely to keep that path honest.

---

## Why the model is Haiku 4.5

Document extraction is high-volume and shallow: a hundred invoices is a hundred
calls, and the reasoning that matters is not "what does this receipt say" but
"who decides whether it is deductible" — which is routed to a person either way.
Haiku 4.5 reads PDFs natively, costs a fraction of the alternatives, and its
200K context is far more than one invoice needs.

Every structured answer comes back through a **forced tool call**, never through
"return JSON" and a parse. A fenced code block or a trailing comma between the
model and a figure that lands on a tax form is not a formatting problem.

---

## How irreversible actions are protected

Five actions change the record a reviewer will act on: resolving an exception,
accepting one, overriding a category, handing off a package, and deleting a
document.

Each one goes through a dialog that **states the consequence** rather than
asking "are you sure", and each requires a **typed note** that lands in the
audit trail beside it. Accepting a flag and resolving one look identical in a
dialog that only says confirm, and they mean different things to whoever reads
the register next — so the dialog says which, in words.

The note is the part that matters. A closed item with no note is a row saying
somebody dealt with this and nothing about what they did; six months later that
is indistinguishable from nobody having looked. The audit trail is append-only,
and a refusal is written to it as readily as an action.

There is no shared confirmation password. One secret in an env file cannot tell
two people apart, cannot be revoked for one of them, and never appears in the
trail — it buys the feeling of a control without the substance of one. Put real
authentication in front of this app before it leaves your machine.

---

## Layout

```
src/lib/          the domain: types, categories, extraction, classification,
                  reconciliation, exceptions, forms, packages, the agent
src/app/api/      one route per verb; every model route is nodejs runtime
src/components/   the shared kit (ui.tsx) and one panel per console tab
scripts/          fixture generator (with its own from-scratch PDF writer),
                  seed, and the end-to-end smoke test
fixtures/         the generated corpus, its manifest, and the ledger CSV
plugins/          the Claude plugin: SKILL.md and its references, including the
                  Tax Prep Console artifact template
.data/            the register — JSON files, gitignored
```

`src/lib/types.ts` and `src/lib/categories.ts` are the contract everything else
is written against. Read them first.

---

## Commands

| | |
|---|---|
| `npm run fixtures` | Generate the mock document corpus and its ledger |
| `npm run seed` | Load the corpus into `.data/` (`--force` to overwrite) |
| `npm run dev` | The console at `localhost:3000` |
| `npm run smoke` | End-to-end pipeline check against the corpus's known truth |
| `npm run lint` | ESLint |
| `npm run build` | Production build |

---

## What is deliberately absent

The AI's authority in this app is defined by absence rather than instruction,
because an instruction is a request and a missing tool is a fact. The agent can
read every document, every category total, every exception and every draft. It
cannot:

- file, submit, e-file or sign anything
- resolve or accept an exception
- override a categorisation
- edit a ledger entry
- hand off a package

All five are human actions in the console. No phrasing of a request produces
them, because they are not in the toolset — an instruction is a request, and a
missing tool is a fact.

---

*New Digital Intelligence · DO-09*
