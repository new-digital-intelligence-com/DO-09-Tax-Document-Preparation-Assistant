# The workspace on Google Drive

Everything this toolkit knows lives in **one shared Google Drive folder**, and
both surfaces — the web app and this skill — read and write the same folder. A
document uploaded in the app is a document you can read here; a category you
record here is one the app shows on its next load. There is no second register.

**Root folder id: `1-ih1p1p9tSBDCCYSXI4lPsxawXUxhQ30`**

You reach it with **the user's own Google Drive connector**. You have no
credentials of your own and need none — the app has its own OAuth client for its
own server, and that is not yours to use. If the connector is not attached, say
so and stop; do not fall back to a local corpus and present it as their data.

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

## Always start with the workspace

**Before anything else — before a search, before a question about a quarter,
before reading a single document — establish whose workspace you are in.** Every
figure you will quote belongs to one person's business, and answering out of the
wrong folder is not a small error: it reports one company's income as another's.

The steps, in order:

1. **List the folders directly under the root.** Each one is a workspace. Skip
   anything that is not a folder.
2. **Read each `profile.json`** for the display name. A folder without one still
   counts — recover a name from the folder name (everything before the last
   hyphen) and say it is a guess.
3. **Put them to the user as options**, with what is in each so the choice is
   recognisable — the entity from `settings.json` and the document count from
   `state/documents.json` where you can read them cheaply. Always include a
   final option to **start a new workspace**.
4. **If they choose a new one, ask for the name** — also as a form, offering
   nothing but a free-text answer if the tool supports it, or asking plainly if
   not. Then create `<slug>-<id>/` with `input/`, `output/` and `state/` inside
   it, and write `profile.json`.

The slug is the name lowercased with runs of non-alphanumerics collapsed to a
single hyphen. The id is a short random suffix so two people called Sam do not
collide. `profile.json` is:

```json
{
  "id": "sam-1c4k2p9xr7",
  "name": "Sam",
  "slug": "sam",
  "createdAt": "2026-09-03T18:00:00.000Z",
  "lastUsedAt": "2026-09-03T18:00:00.000Z"
}
```

**One workspace for the whole conversation.** Having chosen, say which one you
are in the first time you report anything from it, and do not silently switch.
If the user asks about something that is plainly in another workspace, ask
before crossing — as a form, naming both.

## The folder holds the current state and nothing else

**`state/` contains exactly one file per collection. Never more.** No backups,
no copies, no dated variants, no snapshots, no `.bak`, no `-predelete`, no
`-old`, no `-copy`. Not before a delete, not before a risky edit, not "just in
case". If you are about to create a second file, stop: you are about to make
the register ambiguous.

This is not tidiness. Two files called `classifications.json` in one folder is a
register that has silently forked. Drive allows duplicate names, so nothing
errors — one process reads one copy and writes to it, another reads the other,
and the categorisations diverge with no sign that anything is wrong. A person
looking at the folder cannot tell which is real, and neither can you.

Backups are already handled and are not your job:

- **Drive keeps its own version history** on every file. A bad write is
  recoverable from Drive's own UI, with timestamps and authors.
- **Deleting a document trashes rather than erases**, so it is recoverable from
  Drive's trash for weeks.
- **`state/audit.json` is the trail.** Everything that happened is recorded
  there, in one file, which is why there is no need to leave the evidence lying
  around as copies of other files.

A copy you made adds nothing any of those do not already do, and it costs the
one property the folder must have: one file per collection, so that everything
reading it agrees on what the current state is.

### Writing a collection: update, never create a second

Every write is an **update of the existing file**, in place, keeping its id:

1. Find the file by name in `state/`.
2. If it exists, **overwrite that file's content**. Do not create a new one.
3. Only when it does not exist at all do you create it.

If you ever find **two files with the same name** in `state/`, that fork has
already happened. Do not guess: read both, keep the one with more rows or the
later modification time, say what you did and why, and remove the other. Never
leave two behind.

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

A document that arrives through you goes to the same place one uploaded in the
app goes, and in the same shape. Anything less leaves a file in the folder that
the app will treat as an unfamiliar stranger on its next sweep.

1. **Upload the bytes to `input/`**, keeping the original filename.
2. **Compute its SHA-256** and append a row to `state/documents.json`:

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

3. **Write an audit row** to `state/audit.json` saying what arrived and from
   where.

**A byte-identical duplicate is ingested, not refused.** Two copies of the same
invoice is a finding somebody wants: a vendor who billed twice and a folder
synced twice look identical from here, and only a person can tell them apart.
Refusing the second copy hides the question.

**Never write to `output/` by hand.** That cache is keyed on the file's hash and
is what stops a document being read twice. A hand-written entry there teaches
the app an answer nobody checked.

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
the register yourself. What follows are the exact shapes, because the web app
reads these same files and a row in the wrong shape is a row it silently ignores.

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

The web app writes these same files with its own credentials, and neither side
locks anything. If somebody is using the app while you are working, you can both
read a collection, both write it, and the second write discards the first.

The window is a second or so and there is no fix available in a
folder-of-JSON-files design. What you can do is not widen it: read a collection
immediately before writing it rather than holding a copy across several steps,
and write once at the end of a batch rather than after every document.
