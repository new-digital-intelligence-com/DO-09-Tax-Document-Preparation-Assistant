# Driving the Tax Prep Console app

Some capabilities are not Drive or Gmail features at all — they are built on
state this app keeps, so no connector can reach them:

| Capability | Why it is app-only |
|---|---|
| The period register | Drive holds files; it does not hold what was read off them, or which period they belong to |
| Categorisation with a rationale | A category, a confidence and the sentence explaining it, kept beside a human's override rather than replaced by it |
| The ledger and the reconciliation | The accounting system's side, and the deterministic pairing against it |
| The exception list | Sixteen kinds of finding, each with figures, a severity, a suggested action and a status |
| Draft forms | Schedule C, the 1099-NEC summary and the 1040-ES worksheet, computed by arithmetic |
| Review packages | The assembled pack, its markdown, and who it was handed to |
| The audit trail | Append-only history of every action and every refusal, with the note the person typed |

When the app is running (default `http://localhost:3000`), drive these over
HTTP. There is no environment variable for the base URL; if it runs elsewhere,
ask once and use that for the session. When it is not running, say so plainly
rather than answering as though the register had been consulted.

Check it is up before relying on it: `GET /api/status` returns the period, the
counts and whether a model is configured.

## Two registers, and which is which

The app keeps its register in JSON files beside it (`.data/`). This skill, run
against live connectors, reads Drive and Gmail and records nothing. They are
separate: a document you read from a Drive folder is not in the app until it is
ingested there, and a finding the app raised is invisible to a sweep.

Say which one an answer came from. If the app is reachable, its API is the
better path: it writes the record and the audit row in the same step.

**Neither Drive nor Gmail is wired into the app in this build.** Its corpus is
the generated fixture set. `status.sources[]` says so, and `available: false`
there is an absent connector, not a source with nothing in it.

## There is no confirmation password

No route in this app takes a shared-secret header, and no such value exists
anywhere in the product. It was left out deliberately: one secret in an
environment file cannot tell two people apart, cannot be revoked for one of
them, and never appears in the trail. It buys the feeling of a control without
the substance of one.

What protects an irreversible action here is a dialog stating the consequence
plus a **required typed note** that lands in the audit trail. Four routes change
a record and every one of them rejects a blank note with a **400**:

```
POST   /api/classify/override      note required — changing a category
POST   /api/exceptions/resolve     note required — closing or reopening a finding
DELETE /api/documents/{id}         reason required — removing a document
POST   /api/packages/handoff       named recipient required, and never the preparer
```

The 400 body says what was expected. It is the design working, not an obstacle:

> Closing a finding needs a note saying what was found or decided. It is written
> to the audit trail, and a record closed without one reads later as a record
> nobody looked at.

## Status

```
GET /api/status
```

Read this first. Returns the `period`, `modelConfigured`, `counts`, `exceptions`
by severity, `money`, the `forms` generated so far, `latestPackageId`, `sources`,
and `preparerConfigured` / `taxManagerConfigured`.

```bash
curl -s localhost:3000/api/status
```

```json
{
  "period": { "id": "period_2025_q1", "label": "2025 Q1", "entity": "Northwind Studio LLC",
              "start": "2025-01-01", "end": "2025-03-31", "jurisdiction": "US-federal",
              "basis": "cash", "currency": "USD", "status": "open" },
  "modelConfigured": true,
  "counts": { "documents": 39, "extracted": 38, "unreadable": 1, "pendingExtraction": 0,
              "classified": 0, "pendingClassification": 38, "needsReview": 0,
              "ledgerEntries": 38, "matched": 0, "documentOnly": 0, "ledgerOnly": 0 },
  "exceptions": { "open": 0, "high": 0, "medium": 0, "low": 0 },
  "money": { "currency": "USD", "grossReceipts": null, "totalExpenses": null,
             "deductibleExpenses": null, "unclassified": null },
  "forms": [], "sources": [ … ]
}
```

That payload is a period read but not yet categorised, and it is the shape most
likely to be misreported. `exceptions.open: 0` there does not mean the quarter is
clean — detection has not run. `matched: 0` does not mean nothing reconciles —
reconciliation has not run either. Read the counts before the zeros, and say
which steps have not happened.

Two properties of this payload decide how it must be read:

- **Every money figure is `null`, not `0`, when the step that produces it has
  not run.** Gross receipts of `0` is a period with no income; `null` is a
  period nobody has read. Never report one as the other.
- **`sources[]` carries `available`.** `drive` and `gmail` come back
  `available: false` with a detail string saying they were never swept. That is
  not a source with no documents in it.

`status` deliberately carries no net profit. Money on a form is defined once, on
the Schedule C draft, with the adjustments that produced it.

## Categories

```
GET /api/categories
```

The whole chart from `src/lib/categories.ts`, each entry with the period's
`recorded`, `deductible` and `docCount` against it.

```bash
curl -s localhost:3000/api/categories
```

`recorded` and `deductible` differ where `deductiblePct` does, and the difference
is a statutory limit rather than a discrepancy. See
[categories.md](categories.md).

## Settings

```
GET /api/settings
PUT /api/settings          partial Settings
```

Entity, jurisdiction, currency, basis, the active period and the list of
periods, the preparer and tax-manager addresses, `reviewConfidence`,
`capitalisationThreshold`, `contractor1099Threshold`, `recurrenceGapMonths`,
`voice`, and the not-yet-wired `driveFolderId` / `gmailQuery`.

**`entityTaxId` is masked on the way out and never returned in full**, by both
verbs. Keep it that way in anything you write.

## Documents

```
GET    /api/documents               -> {period, documents: DocumentView[]}
POST   /api/documents               multipart upload, form field "file"
GET    /api/documents/{id}          -> {doc, extraction, classification, exceptions}
GET    /api/documents/{id}/file     the PDF itself, served inline
DELETE /api/documents/{id}          {reason} required
```

A `DocumentView` is the document joined with everything known about it: the
extraction, the categorisation, its match and its exceptions.

**A duplicate upload is ingested, not rejected.** The response names what it
duplicates:

```json
{ "ingested": 1, "duplicates": 1, "before": 39,
  "documents": [ { "id": "doc_k3f9", "filename": "adobe-cc-feb-2025.pdf",
                   "duplicateOf": { "id": "doc_f25", "filename": "adobe-cc-feb-2025.pdf" } } ],
  "note": "1 of these is byte-identical to a document already collected. Both were kept — run detection and it will be flagged." }
```

Refusing the second copy would hide that the same invoice arrived twice, and a
vendor billing twice and a folder syncing twice look identical from here.

`GET /api/documents/{id}/file` returns **410** when the row exists but its file
cannot be read from storage, naming the recorded `storagePath`. That is a
missing file, not a missing document, and the difference is the finding.

Removing one needs a reason:

```bash
curl -s -X DELETE localhost:3000/api/documents/doc_f26 \
  -H 'content-type: application/json' \
  -d '{"reason":"Second byte-identical copy of the Adobe invoice; the Drive sync saved it twice. Confirmed with Dana."}'
```

Without `reason` it is a **400**.

## Extraction

```
GET  /api/extract                       -> {extractions}
POST /api/extract   {docId?, limit?}
```

`POST` with a `docId` reads one document; without one it works the pending
queue. Returns `{run, extracted, unreadable, failed, results}`.

```bash
curl -s -X POST localhost:3000/api/extract -H 'content-type: application/json' -d '{"limit":10}'
```

**`unreadable` is a first-class outcome, not an error.** A scan with no legible
figures lands in the results with its filename and its `statusDetail`, and it
belongs on the open-items list rather than being dropped so the counts look
clean.

**503** when `ANTHROPIC_API_KEY` is not set — and nothing is attempted, on
purpose. A run that failed on every document would leave a corpus where "not
extracted" and "unreadable" are mixed together.

## Categorisation

```
GET  /api/classify                                  -> {currency, classifications, totals}
POST /api/classify          {limit?}
POST /api/classify/override {docId, categoryId, note}
```

`POST /api/classify` returns `{run, classified, needsReview, results}`. Each
`Classification` carries a confidence, a one-sentence rationale from the
document's own contents, the runners-up in `alternatives`, and `needsReview`
with its reason.

The override is a human action, and the model's answer is **kept beside** the
human's rather than overwritten — six months later the useful question is not
"what category is this" but "did the assistant get this wrong, and how often".

```bash
curl -s -X POST localhost:3000/api/classify/override \
  -H 'content-type: application/json' \
  -d '{"docId":"doc_f30","categoryId":"expense-depreciation",
       "note":"MacBook Pro at 2,899.00 is over the capitalisation threshold. Moving it off office expense pending Dana deciding between de minimis and section 179."}'
```

| Code | Meaning |
|---|---|
| `400` | No note, no such category, or no categorisation on that document to override |
| `503` | No API key, so nothing can be categorised |

## Ledger

```
GET    /api/ledger          -> {currency, entries}
POST   /api/ledger          {csv}
DELETE /api/ledger          clears the period's entries
```

Columns: `date, description, counterparty, amount, currency, account, ref`. The
import returns `{imported, skipped, problems}` and **`problems` comes back
populated rather than swallowed** — a row that would not parse is a row of the
accounts now missing from the reconciliation, and an import reporting "34
imported" while silently dropping four is how a period reconciles cleanly
against books it does not match. A file missing a required column is refused
whole rather than imported in part.

```bash
curl -s -X POST localhost:3000/api/ledger -H 'content-type: application/json' \
  -d "{\"csv\": $(python3 -c 'import json,sys; print(json.dumps(open("fixtures/ledger-2025-q1.csv").read()))')}"
```

Nothing in this app ever writes to a `LedgerEntry`. The import loads it and the
reconciliation reads it; there is no route that edits one.

## Reconciliation

```
GET  /api/reconcile   -> {currency, matched[], documentOnly[], ledgerOnly[]}
POST /api/reconcile   recompute
```

Deterministic, with no model in it: a pairing a model made up is a pairing
nobody can check. `POST` returns
`{matched, documentOnly, ledgerOnly, amountMismatches}` and is safe to run at
any time.

A `Match` carries `score`, the `reasons` that made or blocked it, and
`amountDelta` where the pairing is right and the figures disagree. **The delta is
never rounded away** — it is the finding.

## Exceptions

```
GET  /api/exceptions?status=&kind=&docId=   -> {currency, exceptions, counts}
POST /api/exceptions/detect                 recompute the findings
POST /api/exceptions/resolve                {id, note, accept?, reopen?}
```

`counts` is computed over the **whole period**, not the filtered slice: a screen
showing "2 open" because a filter is on is a screen hiding the other seven.

Detection is idempotent and safe to re-run. What survives a re-run is a
reviewer's status and their note; what is refreshed is the wording, the figures
and the severity. Findings that no longer apply are dropped, and the drop is
logged. Returns `{raised, carriedForward, byKind}`.

Closing one is a human action with a required note, and `accept` picks between
two genuinely different claims about the period:

```bash
curl -s -X POST localhost:3000/api/exceptions/resolve \
  -H 'content-type: application/json' \
  -d '{"id":"exc_7t2","accept":true,
       "note":"The 18.00 delta is a card fee AWS netted off the payment. Checked against the January statement; the invoice and the ledger are both right."}'
```

| Field | Effect |
|---|---|
| `note` | Required. **400** without it, whichever action |
| `accept: true` | `accepted` — a person looked and it is fine as it stands |
| absent | `resolved` — the underlying problem was fixed |
| `reopen: true` | Puts a closed finding back on the list |

The sixteen kinds are in `ExceptionKind` in `src/lib/types.ts`. Read `detail`
out verbatim: it carries the amounts, the dates and the filenames, and a
paraphrase loses exactly those.

## Draft forms

```
GET  /api/forms                 -> {period, drafts}
GET  /api/forms?formId=         -> {draft, markdown}
POST /api/forms   {formId?}     generate one, or all three
```

```bash
curl -s "localhost:3000/api/forms?formId=schedule-c"
curl -s -X POST localhost:3000/api/forms -H 'content-type: application/json' -d '{}'
```

**404** for a `formId` that has not been generated for this period yet — which is
not the same as a form with nothing on it. See [forms.md](forms.md) for what
feeds which line. `status` is `"draft"` and there is no value it can be set to
instead.

## Packages

```
GET  /api/packages              -> {period, packages}
GET  /api/packages?id=          -> {package, markdown}
POST /api/packages  {summary?}  assemble
POST /api/packages/handoff      {packageId, to?, note?}
```

Assembly **regenerates all three drafts first**, so a package can never carry a
form that predates the categorisation behind it. A stale figure in a pack
somebody is about to file from is worse than no pack.

```bash
curl -s -X POST localhost:3000/api/packages -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:3000/api/packages/handoff \
  -H 'content-type: application/json' \
  -d '{"packageId":"pkg_9d1","to":"dana.whitfield@new-digital-intelligence.com",
       "note":"2025 Q1 for review. Nine items still open, four of them high — the backdated Bright Anvil invoice is the one to look at first."}'
```

The handoff **sends no mail and files nothing.** It records who the pack went to
and when, sets the period to `handed-off`, and hands back the markdown for a
person to send. It refuses with a **400** when there is no recipient, and when
the recipient is the preparer address — a package handed back to the address
that prepared it has been reviewed by nobody, which is the failure the whole
product exists to prevent.

## Audit

```
GET /api/audit?periodId=&docId=&exceptionId=&action=&actor=&limit=
```

Read-only; there is deliberately no write endpoint. `action` matches as a
substring, so `exception` covers `exception.detect`, `exception.resolve`,
`exception.accept`, `exception.reopen`, `exception.restated` and
`exception.retired` in one filter. Newest first — an order that is a property of
how the trail is written rather than a sort applied on read — default limit 200.

The families: `document.*` (ingest, duplicate-detected, delete), `extract.*`,
`classify.*` (run, override, error, partial-batch), `ledger.*` (import, clear),
`reconcile.run`, `exception.*`, `form.generate`, `package.assemble` and
`package.handoff`.

```bash
curl -s "localhost:3000/api/audit?action=exception&limit=50"
```

Every irreversible action carries the note the person typed. Refusals are in
here as readily as actions.

## Chat and drafting help

```
POST /api/chat     {messages}                -> {reply, trace}
POST /api/assist   {kind, …}                 -> {text}
```

`/api/chat` runs the app's own agent over ten read-only tools — `period_status`,
`list_documents`, `get_document`, `search_documents`, `list_categories`,
`category_totals`, `list_exceptions`, `reconciliation`, `list_ledger`,
`get_form_draft`. There is no `resolve_exception`, no `override_category`, no
`edit_ledger`, no `assemble_package`, no `hand_off` and no `file_return`. Those
absences are the agent's authority, and an instruction is a request where a
missing tool is a fact.

`/api/assist` drafts prose and changes nothing. `kind` is one of
`package-summary`, `exception-note`, `vendor-request`, `handoff-note`. A thin
body comes back **400** rather than as fluent invention — a drafted note that
invents a reason closes a finding on grounds nobody ever offered.

```bash
curl -s -X POST localhost:3000/api/assist -H 'content-type: application/json' \
  -d '{"kind":"vendor-request","vendor":"Amazon Web Services",
       "entity":"Northwind Studio LLC","sendTo":"accounts@northwind.studio",
       "items":[{"date":"2025-03-31","amount":2190.44,"currency":"USD","note":"on the ledger, no invoice collected"}]}'
```

Both return **503** when `ANTHROPIC_API_KEY` is not set. That is a state to
report, not a quiet fallback to answering from memory.

## Status codes, across the whole API

| Code | Means |
|---|---|
| `400` | The request was not understood, or a required note or reason was blank. The body says what was expected |
| `404` | No such document, package or generated draft |
| `410` | The document row exists and its file could not be read from storage |
| `500` | A read or write failed. The body carries the reason, and it is never an empty success |
| `503` | `ANTHROPIC_API_KEY` is not set, so nothing was read, categorised or drafted |

A route in this app never answers `[]` because a read failed. An empty list is
an empty list, and a failure is a 500 with a reason — because a route answering
`[]` on a failure tells the reviewer their period is clean.
