# The two connectors

Documents reach this skill from **Google Drive** and **Gmail**, and from nowhere
else. Between them they cover the two ways a business's paperwork actually
exists: the files somebody filed, and the attachments nobody did.

Tool names differ by client — `mcp__claude_ai_Google_Drive__*` and
`mcp__claude_ai_Gmail__*` in the Claude app, whatever the connector registered
as in Claude Code. Check for the capability, not for an exact string, and read
the live schema rather than trusting the argument names below.

## Neither is wired into the web app

The Next.js console at `localhost:3000` does **not** call either connector. Its
corpus is the generated fixture set under `fixtures/`, seeded into `.data/`, and
`GET /api/status` says so in `sources[]`:

```json
{ "source": "drive",  "available": false, "documents": 0,
  "detail": "Google Drive is not wired into this build, so no sweep has run against it…" }
```

`available: false` is an absent connector, not a source with nothing in it. The
app's own settings carry `driveFolderId` and `gmailQuery` for when the sweep is
wired in; today they scope nothing. `.env.example` says the same thing in the
same words.

So there are two collection paths and they do not meet:

| Path | Collects from | Records into |
|---|---|---|
| This skill, in Claude Code or the Claude app | Drive and Gmail, live | Nothing, unless you ingest through the app's API |
| The web app | The generated corpus, plus hand uploads | `.data/` |

Say which one an answer came from. "Eleven invoices in the Drive folder" and
"eleven documents in the period" are different statements, and only the second
one is a fact about the register.

## Google Drive

### The folder convention

```
Finance/<year>/<quarter>/<category folder>
```

The fixture corpus is filed exactly this way, and its `sourceDetail` values are
the folders a real sweep would have walked:

```
Finance/2025/Q1/Invoices out          invoices raised on clients
Finance/2025/Q1/Credit notes          refunds and allowances issued
Finance/2025/Q1/Software              subscriptions, hosting, tools
Finance/2025/Q1/Rent                  office and coworking
Finance/2025/Q1/Insurance
Finance/2025/Q1/Professional services accountants, solicitors, agents
Finance/2025/Q1/Marketing
Finance/2025/Q1/Utilities
Finance/2025/Q1/Vehicle               mileage logs and vehicle costs
```

The category folder is **a filing habit, not a tax categorisation**. A receipt
in `Software` is a receipt somebody put in `Software`; the category comes from
reading the document, not from the folder it sat in. The folder is worth
recording as provenance and worth mentioning when it disagrees with the
categorisation, because a disagreement is usually one of them being wrong.

### Finding the folder

Drive's query language has **no path search**. `title contains 'Finance/2025/Q1'`
matches nothing. Resolve the chain by id, one level at a time:

```
search_files  query: "title = 'Finance' and mimeType = 'application/vnd.google-apps.folder'"
search_files  query: "parentId = '<finance id>' and title = '2025'"
search_files  query: "parentId = '<2025 id>' and title = 'Q1'"
search_files  query: "parentId = '<Q1 id>'"          the quarter's category folders
search_files  query: "parentId = '<category id>'"    the documents themselves
```

Useful terms: `title`, `fullText`, `mimeType`, `parentId`, `owner`,
`createdTime`, `modifiedTime`, `sharedWithMe`. Combine with `and` / `or` / `not`,
single-quote string values, and page with the returned token. **An empty page
token means the listing finished; a listing you stopped early is a listing you
must say you stopped early.**

Then read each file — the metadata call for name, size, mime type and times, and
the content call for the document itself. A PDF that is a scan has no text to
return: that is an `unreadable-document` finding with its filename, not a
document worth nothing.

### What Drive cannot tell you

- **`modifiedTime` is not the document's date.** A March receipt scanned in
  April has an April timestamp and a March date on the page. Never place a
  document in a period by its file timestamp. Where the two disagree badly it is
  worth a look — a file created after the period closed for a document dated
  inside it is one of the backdating signals in
  [rules.md](rules.md) — but the date that counts is the one printed on the page.
- **A folder is not a categorisation**, as above.
- **Nothing about completeness.** Drive cannot tell you the March AWS invoice is
  missing; only the ledger can, by carrying a charge with no document behind it.
- **Nothing about payment.** An invoice in a folder is not an invoice that was
  paid, and on a cash basis that difference decides the period.
- **Whose money it is.** A shared drive holds another entity's paperwork as
  readily as this one's. Scope by entity, and flag anything that names a
  different one rather than reading it through.

## Gmail

Gmail is where the receipts nobody filed live. Most Software-as-a-Service
receipts, airline confirmations and small-vendor invoices exist only as an
attachment on a message, and a period swept from Drive alone looks complete and
is missing all of them.

### Search heuristics

Every search carries the period's date window. The app's own default, from
`.env.example`, is the shape to start from:

```
has:attachment (invoice OR receipt OR statement) after:2025/01/01 before:2025/04/01
```

Note that `before:` is exclusive of the day named, so the day after the period
end is the right value.

Then narrow by the ways these messages actually look:

| Pattern | Query | Catches |
|---|---|---|
| Billing senders | `from:(billing OR invoice OR invoices OR receipts OR noreply OR no_reply OR accounts) has:attachment` | `billing@amazonaws.com`, `receipts@stripe.com`, `message@adobe.com`, `no_reply@email.apple.com` |
| Subject lines | `subject:(invoice OR receipt OR "your order" OR statement OR "payment received")` | The vendors who put it in the subject and not the body |
| Attachment names | `filename:pdf` | Narrows a noisy window |
| Invoices raised | `in:sent has:attachment subject:invoice` | Revenue documents. Easy to forget, and they are the income side of the return |
| A named vendor | `from:hetzner.com after:2025/01/01 before:2025/04/01` | Chasing one gap rather than sweeping again |
| Non-English senders | `subject:(rechnung OR facture OR factura)` | `rechnung@hetzner.com` is in the fixture corpus for exactly this reason |

Two habits that matter more than the queries. **Run each search inside the
period window**, not across the mailbox — the window is the data-minimisation
boundary, and widening it collects documents nobody asked for. And **say which
queries ran**: a person reading "no receipts found" needs to know whether that
means the mailbox was clean or the query was wrong.

### Getting the file itself

`search_threads` returns threads and metadata, not bodies. `get_message` and
`get_thread` return the message, and in their fuller formats the attachment
names and ids alongside it.

**Whether the attachment bytes themselves come back depends on the client.**
Where they do not, the document has not been collected — it has been *seen*.
Say so, and have the file saved to the Drive folder or uploaded to the app
before anything is read off it. An attachment named in a search result is not a
document in the period, and reporting its filename in a document index would put
a row in a package that nothing backs.

### What Gmail cannot tell you

- **A message is not a payment.** An invoice in the inbox may be unpaid, paid
  late, or paid twice. The ledger says which.
- **The message date is not the document date.** A forwarded receipt carries the
  forwarder's date; the page carries the vendor's.
- **A thread is not one document.** A vendor's monthly thread can carry three
  invoices, and the reply below the one you read is a different month.
- **Deleted and archived mail.** A search covers what is in the mailbox now. A
  receipt somebody deleted is invisible here and shows up as a ledger row with
  no support, which is the correct finding rather than a bad sweep.
- **One mailbox is one person's.** Receipts sent to a colleague are not in this
  mailbox at all, and "nothing found" from one account is not "nothing exists".
  Say whose mailbox was searched.

## Two sources, one document

The same invoice frequently arrives in both places: emailed by the vendor, then
saved to the Drive folder. **Keep both.** Deduplication on arrival hides that a
document arrived twice, and a vendor billing twice and a folder synced twice look
identical from here — only a person can tell them apart. The fixture corpus has
this on purpose: `doc_f25` and `doc_f26` are byte-identical, and the `(1)` in the
second filename is the only human-visible tell.

Record where each copy came from. Provenance is what lets a reviewer answer "is
this the same invoice or a second charge", and it is the first thing they ask.

## What neither connector can do

Neither one writes anything to a tax authority, and no combination of them files
a return. There is no submission path in this skill, in the web app, or in the
connectors themselves. Nothing collected here has been filed.
