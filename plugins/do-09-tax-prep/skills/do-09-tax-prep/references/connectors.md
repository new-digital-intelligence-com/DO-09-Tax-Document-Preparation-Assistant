# The connectors

Two, with sharply different jobs:

| Connector | What it is for | Scope of what you touch |
|---|---|---|
| **Google Drive** | The workspace itself — the whole register lives in a Drive folder — and importing documents the user already has | The shared root, plus whatever files they explicitly pick from their own Drive |
| **Gmail** | **Sending only.** Emailing the finished review package from the user's own address | One outgoing message, when they asked for it |

Tool names differ by client — `mcp__claude_ai_Google_Drive__*` and
`mcp__claude_ai_Gmail__*` in the Claude app, whatever the connector registered
as in Claude Code. Check for the capability, not for an exact string, and read
the live schema rather than trusting argument names.

## Gmail is not a source of documents

This is the rule most likely to be violated by good intentions, so it is stated
first and stated absolutely: **never search, list, read or open anybody's mail.**
Not for invoices, not to check a vendor, not to confirm a subscription, not to
see whether something exists — and not because the user asked you to.

It has been got wrong in practice. Asked *"do I have an Anthropic
subscription?"*, the obvious-looking move is to search the mailbox, and it is
wrong twice over: it reads private correspondence, and it answers a question
whose answer was already sitting in `state/extractions.json`. Questions about
what somebody has, paid or was billed for are questions about **collected
documents**. The register answers them. When the register cannot, the honest
answer is that the document was never collected — not a reason to go hunting.

Sweeping mail for receipts was built into the web app and then deliberately
removed, along with the permission behind it — the app requests no
mailbox-read scope anywhere. A tax workspace is the worst possible place to
accumulate somebody's correspondence: it aggregates bank details, tax
identification numbers, home addresses on sole traders' invoices and a full
picture of who a business pays. The only defence that actually holds is not
having the permission, so the collection path was closed rather than narrowed.

If a user wants an emailed invoice in the period, they save the attachment and
add it as a document like any other. That is one extra step for them and a
category of exposure removed for everybody.

What Gmail *is* for is the last step: sending the assembled package to the tax
manager, from the user's own address so the recipient can reply to a person.
Confirm the recipient as a form before sending, and never send to check that it
works — there is no draft mode and the tax manager receives whatever you send.

## Google Drive: the workspace

Everything this toolkit knows lives under one shared folder,
**`1-ih1p1p9tSBDCCYSXI4lPsxawXUxhQ30`**, one subfolder per person. That is not a
place documents are copied *to* after being collected — it is the register
itself, the same files the web app reads and writes.

The layout, how to list the workspaces, how to create one, and how to add or
remove a document so the app agrees with you afterwards are all in
[workspace.md](workspace.md). Read it before writing anything.

The app reaches the same folder with its own server-side OAuth client. That
credential is the app's; you use the user's connector. Neither sees more than
the other, and neither is a fallback for the other.

## Google Drive: importing what they already have

The second use is the user's *own* Drive — the finance folders where their
paperwork already sits.

Search it for PDFs and scans, put the matches to them **as options**, and copy
across only what they tick. Never sweep it wholesale: a search that pulls a
vendor's whole history to file one quarter has collected documents nobody asked
for, and data minimisation is a rule here rather than a preference.

**Copy the bytes, never a reference.** A link into somebody's personal Drive
breaks the moment they move the file, rename it or revoke access, and a package
that cannot produce the document behind a figure is not a package.

A common folder convention, worth trying before asking where things are:

```
Finance/<year>/<quarter>/<category folder>
```

But **a folder is not a categorisation.** A file in `Software` is evidence about
where somebody filed it, not a decision about which tax line it reaches. Read
the document.

### What Drive cannot tell you

- **`modifiedTime` is not the document's date.** A March receipt scanned in
  April has an April timestamp and a March date on the page. The date that
  counts is the one printed on the page.
- **Nothing about payment.** An invoice in a folder is not an invoice that was
  paid, and on a cash basis that difference decides the period.
- **Nothing about completeness.** Drive cannot tell you an invoice is missing.
  A vendor who billed either side of a gap is the signal, and that comes from
  reading the documents you do have.
- **Whose money it is.** A shared drive holds another entity's paperwork as
  readily as this one's. Scope by entity, and flag anything naming a different
  one rather than reading it through.

## The same document arriving twice

**Keep both.** Deduplicating on arrival hides that a document arrived twice, and
a vendor billing twice and a folder synced twice look identical from here — only
a person can tell them apart. Record where each copy came from; provenance is
what lets a reviewer answer "is this the same invoice or a second charge", which
is the first thing they ask.

## What neither connector can do

Neither one writes anything to a tax authority, and no combination of them files
a return. There is no submission path in this skill, in the web app, or in the
connectors themselves. Nothing collected here has been filed.
