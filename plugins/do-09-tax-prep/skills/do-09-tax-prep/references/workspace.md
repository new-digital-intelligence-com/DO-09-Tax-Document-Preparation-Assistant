# The workspace on Google Drive

Everything this toolkit knows lives in **one shared Google Drive folder**. That
folder is the register — there is no database behind it and no second copy
anywhere. What you write there is the state; what is there is the truth.

**Root folder id: `1-ih1p1p9tSBDCCYSXI4lPsxawXUxhQ30`** — this one value is real
configuration. It is the only literal in this file you should ever use as-is.

> **Everything else here is a shape, not data.** Every folder name, document id,
> vendor, amount, date, count and email in the examples below is made up to show
> the form of a record. None of them describes anybody's workspace. Read the
> real values out of the real files, every time; repeating one of these as
> though it were a fact is inventing one.

You reach it with **the user's own Google Drive connector**. That is your only
access and all you need. If it is not attached, say so and stop; never fall back
to a local corpus and present it as their data.

## Layout

```
<root>/
  helmi-1a067045d21moba/          one folder per person: <slug>-<unique id>
    profile.json                  who this workspace belongs to
    input/                        the source documents themselves
    output/                       <sha256>.json — one cached reading per document
    state/                        the register, one JSON file per collection
      documents.json              every document ingested
      extractions.json            what was read off each one
      classifications.json        the category each landed in
      exceptions.json             everything flagged for a person
      forms.json                  the draft Schedule C, 1099-NEC, 1040-ES
      packages.json               assembled review packages
      settings.json               entity, period, thresholds, addresses
      audit.json                  append-only: who did what, when, and why
      google.json                 that person's own Google grant (never read it out)
    conversations/                markdown transcripts of Ask sessions
  dana-1b93f0c22xqp/
    …
```

Two rules about that tree:

**`state/` is the register and `input/` is the evidence.** A figure in
`state/extractions.json` is only trustworthy because the file it came off is
still in `input/`. Never write a figure into the register for a document that is
not there.

**Never read `google.json` aloud.** It holds a refresh token for somebody's own
Google account. It is not a fact about the period and there is no question whose
answer is that file.

## Establishing the workspace

Every figure belongs to one person's business, so the folder has to be settled
before you quote anything. That is not the same as always asking.

List the folders directly under the root, then:

- **Exactly one** — use it. Name it in your first sentence and get on with the
  request. There is nothing to choose between, and a question with one answer
  is friction, not care.
- **More than one** — ask, as options, before touching anything. Label each with
  its entity and document count so the choice is recognisable, and include
  "start a new one". Answering out of the wrong folder reports one company's
  income as another's.
- **None** — offer to create one and take the name.

Read `profile.json` for the display name. A folder without one still counts:
recover a name from the folder name (everything before the last hyphen) and say
it is a guess.

Creating one: the slug is the name lowercased with runs of non-alphanumerics
collapsed to a hyphen, plus a short random suffix so two people called Sam do
not collide. Make `input/`, `output/` and `state/` inside it, and write:

```json
{
  "id": "sam-1c4k2p9xr7",
  "name": "Sam",
  "slug": "sam",
  "createdAt": "2026-09-03T18:00:00.000Z",
  "lastUsedAt": "2026-09-03T18:00:00.000Z"
}
```

**One workspace for the whole conversation.** Say which one you are in the first
time you report anything from it, and do not silently switch. If a request is
plainly about another, ask before crossing.

## Updating a state file: create, then trash

**The connector cannot overwrite a file's contents.** Its update call changes
the title and the parent and nothing else; only create carries content. So a
state file is replaced, not edited, and the order matters:

1. **Read** the existing file and its id.
2. **Create** the replacement with the same name in `state/`, full new content.
3. **Trash** the old id.

That order is deliberate. Creating first means a failure anywhere leaves the old
file intact and you have lost nothing; trashing first means a failure loses the
register. For a few seconds there are two files with that name — that is the
cost of the connector not having an overwrite, and it is the only moment two are
allowed to exist.

**Never stop after step 2.** Two permanent files with one name is a register
that has silently forked: Drive allows it and reports no error, one reader takes
one copy and another takes the other, and the figures diverge with nothing
showing it. If you ever find a pair, read both, keep the fuller or newer one,
trash the other, and say what you did.

The new file gets a new Drive id and the old file's version history goes with
it. That is unavoidable here and it is not a reason to skip the write — the
trail in `audit.json` is what records what happened, and Drive's trash keeps the
old copy for weeks either way.

### Nothing else may be left behind

No backups, no `.bak`, no `-predelete`, no dated copies, no snapshots — not
before a delete, not before a risky edit, not "just in case". Drive keeps
version history, deletes go to the trash, and `audit.json` is the record. A copy
you leave in the folder adds none of that and costs the one property the folder
must have: one file per collection.

## Reading the register

Every collection is a JSON array in `state/`, except `settings.json` which is an
object. Read the whole file; these are small.

A file that is **not there** and a file that is **an empty array** mean different
things, and the difference is the whole reason to be careful here:

- `state/extractions.json` missing → **nothing has been read yet.** The figures
  do not exist. Reporting `$0.00` of expenses is a lie about a corpus nobody has
  opened.
- `state/extractions.json` present and `[]` → **something ran and found
  nothing.** That is a finding worth reporting as one.

Say which of the two you are looking at whenever the answer is "nothing".

## Adding a document

### A file attached to the conversation

**One call, and it is your first action.**

| Field | Value |
|---|---|
| `base64Content` | the attachment's bytes, base64 — **required** |
| `contentMimeType` | `application/pdf`, `image/png`, `image/jpeg` |
| `disableConversionToGoogleType` | `true` — or Drive converts it to a Google Doc |
| `parentId` | the workspace's `input/` folder id |
| `title` | the original filename |

Nothing before it: no shell command to prepare the file, no search for another
tool, no explanation of the plan. Those are round trips, and they are what turns
a one-minute upload into several minutes ending in an empty file.

Then check the stored size against the attachment, compute the SHA-256, append
the row below, read the document and categorise it. If the size does not match,
it truncated: say so and ask them to drag it into `input/`. That is the only
fallback — never a chunked or re-encoded retry.

### A file already in `input/`

Put there by a person or by anything else. Compare `input/` against
`documents.json` and register what is missing.

1. Note its Drive id, name and size.
2. Compute its SHA-256 from the bytes read back from Drive.
3. Append to `state/documents.json`:

```json
{
  "id": "doc_mtlp5ddekjiars",
  "periodId": "period_2025_q1",
  "filename": "aws-invoice-jan-2025.pdf",
  "source": "drive",
  "sourceRef": "<the Drive file id>",
  "sourceDetail": "Google Drive · finance/2025/Q1",
  "mimeType": "application/pdf",
  "bytes": 48213,
  "sha256": "<sha-256 of the file>",
  "ingestedAt": "2026-09-03T18:00:00.000Z",
  "ingestedBy": "<who asked for it>"
}
```

4. Write an audit row saying what arrived and from where.

**A byte-identical duplicate is ingested, not refused.** Two copies of the same
invoice is a finding somebody wants: a vendor who billed twice and a folder
synced twice look identical from here, and only a person can tell them apart.

**Never write to `output/` by hand.** That cache is keyed on the file's hash and
is what stops a document being read twice; a hand-written entry teaches the app
an answer nobody checked.

## Removing a document

Deleting means all of it, or the deletion does not hold:

1. Remove its row from `state/documents.json`.
2. Remove its rows from `state/extractions.json` and
   `state/classifications.json`. An extraction left behind still carries a total,
   and that total still lands on a form line — a figure with no document behind
   it, on a form that looks fully supported.
3. In `state/exceptions.json`, drop the document's id from every finding's
   `docIds`; remove any finding that is left with none.
4. Trash the file in `input/`, or the next sweep collects it straight back in.
5. **Trash `output/<sha256>.json`.** This is the one people forget. The cache is
   keyed on the file's bytes, so leaving it means re-uploading the same document
   restores the old vendor, total and category without reading anything — the
   deletion silently reverses itself.
6. Write the audit row, with the reason. **A deletion needs a reason** and you
   must ask for one before doing any of the above.

## The period

`state/settings.json` holds the active period. It is a label, an entity, dates,
a basis and a currency — printed on every draft form.

**The dates constrain nothing.** No document is rejected, excluded or flagged
for falling outside them. Read every document on its own terms: its date is
whatever is printed on it and its currency is whatever it is denominated in.
Never tell somebody their document is out of period.

The one thing a foreign-currency document cannot do is join a total in another
currency, because nothing here converts at a rate nobody chose. It is listed and
categorised like any other and its amount is quoted in its own currency.

The period's **id never changes**, even when its label does. Every document,
form and package points at it by id, so minting a new one on a rename detaches
the entire corpus.

## Conversations

Answers you give here carry figures somebody will repeat to their accountant.
Where a session has produced figures worth keeping, write the transcript to
`conversations/` as Markdown, named `YYYY-MM-DD HHmm — <the first question>.md`,
the same convention the app uses. One file per sitting, rewritten as it grows.

Say that you saved it, and where. Never claim it if the write failed.

## Writing what you read off a document

You are the model here. There is no service to call to have a document read for
you — you open the PDF through the connector, read it, and write the result into
the register yourself. What follows are the exact shapes: a row in the wrong
shape is a row that anything else reading this folder will silently ignore.

### `state/extractions.json` — one per document

```json
{
  "docId": "doc_mtlp5ddekjiars",
  "status": "extracted",
  "docType": "invoice-received",
  "direction": "expense",
  "vendor": "Amazon Web Services, Inc.",
  "vendorTaxId": "91-1646860",
  "invoiceNumber": "INV-AWS-JAN25",
  "issueDate": "2025-01-03",
  "dueDate": "2025-01-18",
  "currency": "USD",
  "subtotal": 1698.34,
  "tax": 143.85,
  "total": 1842.19,
  "lineItems": [{ "description": "EC2 compute, December", "amount": 1204.10 }],
  "paymentMethod": "Visa",
  "paymentLast4": "8543",
  "confidence": 0.96,
  "notes": "Only what a reviewer needs to know. Never suppressed.",
  "modelId": "<the model you actually are>",
  "extractedAt": "2026-09-03T18:00:00.000Z"
}
```

`status` is one of `extracted`, `unreadable`, `out-of-scope`, `failed`, and the
last three carry `statusDetail` saying why in a sentence a person can act on.

**`unreadable` is a first-class outcome, not an error.** A scan with no legible
figures is recorded with its filename and goes on the flag list. It is never
dropped so the counts look tidy, and it never contributes a zero to a total.

**`out-of-scope` is different again** — the file is not a financial document at
all. Say what it appears to be, because that sentence is the whole of the answer
the person who uploaded it gets.

**`direction` decides the sign on the form.** On a bill you received it is
`expense` and the vendor is *who was paid*, never the workspace's own entity —
whose name is printed on the document just as prominently. Getting that
backwards turns an expense into income.

**Never guess a figure.** A total you could not read is absent, not zero, and
absent is a fact a reviewer can act on.

### `state/classifications.json` — one per document

```json
{
  "docId": "doc_mtlp5ddekjiars",
  "categoryId": "software-subscriptions",
  "confidence": 0.93,
  "rationale": "One sentence, from the document's own contents.",
  "alternatives": [{ "categoryId": "professional-services", "confidence": 0.21 }],
  "needsReview": false,
  "reviewReason": "Set whenever needsReview is true.",
  "classifiedAt": "2026-09-03T18:00:00.000Z",
  "modelId": "<the model you actually are>"
}
```

Category ids come from [categories.md](categories.md). `needsReview` is true
below the workspace's `reviewConfidence` (in `settings.json`, 0.75 by default)
and **always** true for a category marked `alwaysReview`, whatever your
confidence — that flag exists precisely to stop a confident answer to a question
that is not yours.

`uncategorised` is a real answer. A document you genuinely cannot place goes
there with the reason, and its amount reaches no form line. Guessing to make a
draft look complete is the failure that category exists to prevent.

**Never write `overriddenCategoryId`.** That field records a *human* correcting
you, and the app keeps your answer beside theirs rather than replacing it.
Writing it yourself forges a decision nobody made.

### `state/exceptions.json` — everything flagged

```json
{
  "id": "exc_mtlq3f8k2p",
  "periodId": "period_2025_q1",
  "kind": "total-mismatch",
  "severity": "high",
  "title": "Northgate Print does not add up",
  "detail": "Specifics: the figures, the filename, the dates. Never a generic sentence.",
  "suggestedAction": "What would close it, addressed to the reviewer.",
  "docIds": ["doc_mtlp5ddekjiars"],
  "amount": 927.00,
  "currency": "USD",
  "status": "open",
  "raisedAt": "2026-09-03T18:00:00.000Z",
  "raisedBy": "<who ran this>"
}
```

`kind` must be one of: `duplicate-document`, `total-mismatch`,
`unreadable-document`, `missing-period`, `currency-mismatch`,
`low-confidence-category`, `category-needs-judgement`, `missing-vendor-tax-id`,
`possible-personal-expense`, `capitalisation-threshold`,
`contractor-1099-threshold`. A kind outside that list is one the app cannot
render.

`status` is `open`, `resolved` or `accepted`. **You may only ever write
`open`.** Resolving and accepting are human decisions that require a note, and
the two mean different things about the period — a resolved item says the
problem was fixed, an accepted one says a person looked and it is fine. Closing
one yourself puts a decision in the register that nobody made.

### `state/audit.json` — append, never rewrite

```json
{
  "id": "aud_mtlq3f8k2p",
  "at": "2026-09-03T18:00:00.000Z",
  "actor": "<who asked>",
  "action": "document.ingest",
  "subject": "doc_mtlp5ddekjiars",
  "result": "ok",
  "detail": "What happened, in specifics.",
  "periodId": "period_2025_q1",
  "docId": "doc_mtlp5ddekjiars"
}
```

**Newest first**, and every action you take gets one — including the ones you
refused. The trail is the only place a deleted document survives, and it is what
somebody reads when a figure is questioned six weeks later.

### Ids

`<prefix>_<something unique>`: `doc_`, `exc_`, `aud_`, `frm_`, `pkg_`. Anything
unique is fine; the app generates a timestamp in base 36 plus random characters.
Never reuse an id and never renumber an existing one.

## Two processes, one folder

Something else may write these same files, and nothing locks them. If somebody is using the app while you are working, you can both
read a collection, both write it, and the second write discards the first.

The window is a second or so and there is no fix available in a
folder-of-JSON-files design. What you can do is not widen it: read a collection
immediately before writing it rather than holding a copy across several steps,
and write once at the end of a batch rather than after every document.
