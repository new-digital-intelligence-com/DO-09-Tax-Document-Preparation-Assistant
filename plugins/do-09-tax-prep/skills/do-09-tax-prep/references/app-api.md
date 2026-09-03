# Driving the Tax Prep Console app

Some capabilities are not Drive or Gmail features at all — they are built on
state this app keeps, so no connector can reach them:

| Capability | Why it is app-only |
|---|---|
| The period register | Drive holds files; it does not hold what was read off them, or which period they belong to |
| Categorisation with a rationale | A category, a confidence and the sentence explaining it, kept beside a human's override rather than replaced by it |
| The workspace | One shared Drive folder, one subfolder per person, holding every document and the whole register |
| The exception list | Sixteen kinds of finding, each with figures, a severity, a suggested action and a status |
| Draft forms | Schedule C, the 1099-NEC summary and the 1040-ES worksheet, computed by arithmetic |
| Review packages | The assembled pack, its markdown, and who it was handed to |
| The audit trail | Append-only history of every action and every refusal, with the note the person typed |

`$APP` in every example below is the base URL. It is the deployment —
`https://do-09-tax-document-preparation-assi.vercel.app` — except in Claude
Code, where a dev server on port 3000 of the local machine is tried first. The
SKILL says which applies where; in the Claude app there is no local machine, so
only the deployment exists.

If the app runs somewhere else again, ask once and use that for the session.
When nothing answers, say so plainly rather than answering as though the
register had been consulted.

Check it is up before relying on it: `GET /api/status` returns the period, the
counts and whether a model is configured.

## One register, two ways in

There is no "the app's data" and "your data". The app keeps nothing beside
itself — no local database, no `.data/` directory — and writes everything to the
**same shared Google Drive folder** this skill reads:
`1-ih1p1p9tSBDCCYSXI4lPsxawXUxhQ30`, one subfolder per person. A document
uploaded in the app is one you can read here; a row you write here is one the
app shows on its next load.

What differs is only the credential. The app reaches that folder with its own
server-side OAuth client; you reach it with the user's own Drive connector.
Neither is a substitute for the other and neither sees more than the other.

**Prefer this API whenever the app is reachable.** It writes the record and the
audit row in one step and enforces the rules in code rather than in a prompt,
which is strictly safer than making the same edits by hand. When it is not
reachable, do the same work through the connector against the same files —
[workspace.md](workspace.md) has the layout — so the outcome is
indistinguishable.

Say which route an answer came from when it matters: "read from the register"
and "opened the file myself just now" are different claims.

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
POST   /api/packages/send          named recipient required, and never the preparer
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
curl -s "$APP/api/status"
```

```json
{
  "period": { "id": "period_2025_q1", "label": "2025 Q1", "entity": "Northwind Studio LLC",
              "start": "2025-01-01", "end": "2025-03-31", "jurisdiction": "US-federal",
              "basis": "cash", "currency": "USD", "status": "open" },
  "modelConfigured": true,
  "counts": { "documents": 39, "extracted": 38, "unreadable": 1, "pendingExtraction": 0,
              "classified": 0, "pendingClassification": 38, "needsReview": 0,

  "exceptions": { "open": 0, "high": 0, "medium": 0, "low": 0 },
  "money": { "currency": "USD", "grossReceipts": null, "totalExpenses": null,
             "deductibleExpenses": null, "unclassified": null },
  "forms": [], "sources": [ … ]
}
```

That payload is a period read but not yet categorised, and it is the shape most
likely to be misreported. `exceptions.open: 0` there does not mean the quarter is
clean — detection has not run. Read the counts before the zeros, and say
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
curl -s "$APP/api/categories"
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
curl -s -X DELETE "$APP/api/documents/doc_f26" \
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
curl -s -X POST "$APP/api/extract" -H 'content-type: application/json' -d '{"limit":10}'
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
curl -s -X POST "$APP/api/classify/override" \
  -H 'content-type: application/json' \
  -d '{"docId":"doc_f30","categoryId":"expense-depreciation",
       "note":"MacBook Pro at 2,899.00 is over the capitalisation threshold. Moving it off office expense pending Dana deciding between de minimis and section 179."}'
```

| Code | Meaning |
|---|---|
| `400` | No note, no such category, or no categorisation on that document to override |
| `503` | No API key, so nothing can be categorised |

## Workspaces and the period

```
GET  /api/users                 -> {users, active, drive}
POST /api/users        {name}   create one
POST /api/users/active {id}     switch to one
GET  /api/settings/period       -> {period}
PUT  /api/settings/period       {label?, entity?, start?, end?, currency?, basis?}
```

Every user is a folder under the shared Drive root, read fresh from Drive rather
than from any local list — so the same workspaces appear on any machine. The
active one is a cookie, which is why the app has a picker and no sign-in.

`PUT /api/settings/period` changes what the period is **called** and what it
covers. It never changes the period's id, and neither may you: every document,
form and package points at it, so a new id detaches the whole corpus. The dates
constrain nothing — no document is rejected or flagged for falling outside them
— they are printed on the forms.

## Google, and importing from a person's own Drive

```
GET    /api/google/account        -> {connected, email, can:{driveImport, gmailSend}}
GET    /api/google/connect        redirect to consent (per person, not the app's own)
DELETE /api/google/account        disconnect and revoke
GET    /api/import/drive?q=       -> {files}   search THEIR Drive
POST   /api/import/drive {fileIds} copy the chosen ones into the workspace
```

Two different Google connections exist and conflating them is a privacy failure.
The **workspace** connection is the app's own server credential, `drive.file`
only, owning the shared folder. The **account** connection is per person —
`drive.readonly` so they can import a file they already have, and `gmail.send`
so a package can go from their own address. No mailbox-read scope is requested
anywhere: importing attachments from mail was built and deliberately removed.

Both import routes answer **409**, not 500, when no account is connected or the
needed permission was not granted. That is a step to take, not a fault.

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
curl -s -X POST "$APP/api/exceptions/resolve" \
  -H 'content-type: application/json' \
  -d '{"id":"exc_7t2","accept":true,
       "note":"The 18.00 gap is a card fee AWS netted off the payment. Checked against the January statement; both figures on the invoice are right."}'
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
curl -s "$APP/api/forms?formId=schedule-c"
curl -s -X POST "$APP/api/forms" -H 'content-type: application/json' -d '{}'
```

**404** for a `formId` that has not been generated for this period yet — which is
not the same as a form with nothing on it. See [forms.md](forms.md) for what
feeds which line. `status` is `"draft"` and there is no value it can be set to
instead.

## Packages

```
GET  /api/packages              -> {period, packages}
GET  /api/packages?id=          -> {package, markdown}
GET  /api/packages/pdf[?id=]    -> application/pdf, DRAFT on every page
POST /api/packages  {summary?}  assemble
POST /api/packages/handoff      {packageId, to?, note?}    records only
POST /api/packages/send         {packageId, to?, cc?, note?}  emails AND records
```

`send` is the only thing anywhere that emails a package, and it exists for this
skill rather than for the console — the app deliberately has no send button, so
that a pack leaves by a person who read it rather than by a click on the way
past. It goes out from the workspace owner's own connected Google account, so
the recipient can reply to a human; it needs `gmail.send` on that connection and
returns **409** with a plain reason when there is none.

Sending and recording the handoff are one act. The mail goes first, because that
is the part that can fail for reasons outside this app, and the handoff is
written only once it has actually gone — a register claiming a review is under
way that nobody was told about is the failure this ordering prevents.

Confirm the recipient with the person before calling it. Never call it to check
that it works: there is no draft mode, and the tax manager receives whatever you
send.

Assembly **regenerates all three drafts first**, so a package can never carry a
form that predates the categorisation behind it. A stale figure in a pack
somebody is about to file from is worse than no pack.

```bash
curl -s -X POST "$APP/api/packages" -H 'content-type: application/json' -d '{}'
curl -s -X POST "$APP/api/packages/handoff" \
  -H 'content-type: application/json' \
  -d '{"packageId":"pkg_9d1","to":"dana.whitfield@new-digital-intelligence.com",
       "note":"2025 Q1 for review. Nine items still open, four of them high — the Northgate invoice whose lines do not add up to its total is the one to look at first."}'
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

The families: `document.*` (ingest, reused, declined, delete, cache.cleared),
`extract.*`, `classify.*` (run, override, error, partial-batch), `exception.*`,
`form.generate`, `period.updated`, `google.*` (connected, disconnected), and
`package.*` (assemble, handoff, emailed, downloaded).

The trail is also the **only** place a deleted document survives. Search it by
filename before telling anybody no record of something exists — "it was never
here" and "it was deleted on Tuesday, with a reason" are different answers and
usually only one of them is true.

```bash
curl -s "$APP/api/audit?action=exception&limit=50"
```

Every irreversible action carries the note the person typed. Refusals are in
here as readily as actions.

## Chat and drafting help

```
POST /api/chat     {messages}                -> {reply, trace}
POST /api/assist   {kind, …}                 -> {text}
```

`/api/chat` runs the app's own agent over nine read-only tools — `period_status`,
`list_documents`, `get_document`, `search_documents`, `list_categories`,
`category_totals`, `list_exceptions`, `list_audit`, `get_form_draft`. There is no
`resolve_exception`, no `override_category`, no `assemble_package`, no `hand_off`
and no `file_return`. Those absences are the agent's authority, and an
instruction is a request where a missing tool is a fact.

Each reply is saved to `conversations/` in the workspace folder as Markdown, so
a figure quoted to an accountant can be traced back to the question that
produced it.

`/api/assist` drafts prose and changes nothing. `kind` is one of
`package-summary`, `exception-note`, `vendor-request`, `handoff-note`. A thin
body comes back **400** rather than as fluent invention — a drafted note that
invents a reason closes a finding on grounds nobody ever offered.

```bash
curl -s -X POST "$APP/api/assist" -H 'content-type: application/json' \
  -d '{"kind":"vendor-request","vendor":"Amazon Web Services",
       "entity":"Northwind Studio LLC","sendTo":"accounts@northwind.studio",
       "items":[{"date":"2025-03-31","amount":2190.44,"currency":"USD","note":"billed either side of this month, nothing on file for March"}]}'
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
