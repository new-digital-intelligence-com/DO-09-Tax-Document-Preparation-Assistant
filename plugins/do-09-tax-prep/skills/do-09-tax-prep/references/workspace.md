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
