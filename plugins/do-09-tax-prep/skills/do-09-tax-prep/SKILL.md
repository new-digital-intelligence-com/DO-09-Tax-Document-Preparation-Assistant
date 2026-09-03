---
name: do-09-tax-prep
description: Prepare a filing period from source documents. Use whenever the user wants to collect invoices, receipts or statements for a quarter or a year; sort them into tax categories; reconcile documents against a ledger; find missing invoices or unsupported ledger entries; see what is flagged before an accountant looks at it; draft a Schedule C, a 1099-NEC summary or a 1040-ES worksheet; or assemble a review package for a tax manager. It files nothing.
---

# Tax Document Preparation Assistant

Collect a filing period's invoices, receipts and financial documents, read each
one, categorise it against the firm's chart, reconcile it against the ledger,
flag every inconsistency for a human, and assemble the package a tax manager
reviews.

Documents come from **two connectors**: Google Drive for the finance folders and
Gmail for everything that only ever arrived as an attachment.

**The one thing this skill will not do is file.** Every form it produces is a
draft, and a person reviews the pack and files it. You prepare what they review.

## 1. Read the operating rules

**[references/rules.md](references/rules.md) is the behaviour contract** — the
three invariants, data minimisation, what closing a flag requires, what to
escalate on sight, and how to report a failure. Read it before acting.

The companion web app reads the same file into its own agent's system prompt
(`src/lib/skills.ts`), so a rule changed once applies to Claude Code, the Claude
app and the app's chat panel alike. Do not restate those rules in a second
prompt that can drift from them.

The three that everything else hangs off:

1. **Nothing is filed.** No submission, no signature, no "final".
2. **Flag, never fix silently.** The difference between a document and the
   ledger is the finding. Adjusting it away destroys the evidence.
3. **No tax advice.** Deductibility is not yours to decide. Route it with the
   document attached.

## 2. Check the connectors are actually there

A skill is instructions only; it carries no tool access. Everything below needs
the connectors attached in this client, and you need no credentials of your own
— no folder id, no mailbox, no token.

Confirm you can see both before starting:

| Connector | Gives you | Without it |
|---|---|---|
| **Google Drive** | The finance folders: invoices out, receipts in, statements, the ledger export | No corpus. You can read a mailbox and prepare nothing |
| **Gmail** | Invoices and receipts that only ever arrived as attachments — the ones nobody filed | A period that looks complete and is missing every emailed receipt |

Names differ by client. In the Claude app they appear as
`mcp__claude_ai_Google_Drive__*` and `mcp__claude_ai_Gmail__*`; in Claude Code
they follow whatever the connector is registered as. Check for the capability,
not for an exact string.

**If either is missing, say plainly which one and stop.** That is the operator's
to fix, not yours. Do not answer from memory and do not proceed on one
connector while implying you swept both — a period assembled from half its
sources is not an incomplete answer, it is a wrong one, and it reads as
complete. A sweep that could not run reports as *not checked*, never as zero
documents. See [references/connectors.md](references/connectors.md) for what
each one can and cannot tell you.

### When no connector is attached: the local corpus

This repo ships a generated corpus that stands in for a real sweep, and in
Claude Code with the repo open it is the source to work from:

```
fixtures/manifest.json        39 documents, their sources and their known truth
fixtures/documents/           the PDFs themselves
fixtures/ledger-2025-q1.csv   38 ledger rows, the accounting system's side
```

It is one entity and one period: **Northwind Studio LLC, 2025 Q1**
(`period_2025_q1`, 2025-01-01 to 2025-03-31, cash basis, USD, US federal).

Two things about the manifest. It records where each document *would* have come
from — a Drive folder, a Gmail sender — so the sweep's shape is real even though
no sweep ran. And `expectedFindings` is the corpus's known truth, there so a run
can be checked against it. **Use it to verify your work, never to answer with.**
Reading the answer key and reporting it as a finding is not a preparation, and
the documents are right there to read.

In the Claude app there is no filesystem, so there is no corpus either. With no
connectors and no repo, say so and stop.

## 3. The period is the unit of work

Everything is scoped to a filing period: an entity, a start and end date, a
basis, a currency and a jurisdiction. Nothing is prepared "in general".

Establish the period **before** the first search, not after. Scoping a sweep
afterwards means the wider set was already collected, and data minimisation is a
rule here rather than a preference — a sweep that pulls a vendor's whole history
to file one quarter has taken documents nobody asked for.

- **Cash or accrual decides which date rules.** On a cash basis the payment date
  places a document in the period; on accrual it is the invoice date. Ask, do
  not assume.
- **The reporting currency is the period's.** A document in another currency is
  flagged, never converted — no rate is printed on it, and a rate you chose is a
  figure nobody can check.
- **A document dated outside the period is a finding**, not a document to file
  quietly under the neighbouring quarter.

## 4. The three workflows

### A. The collection sweep

Find the period's documents, in both places, and know what you did not find.

1. **Scope it.** Entity, period start and end, and the finance folder root.
2. **Sweep Drive**, folder by folder under the year and quarter. Record the file
   id and the folder it came from — provenance is what lets a reviewer go back
   to the original.
3. **Sweep Gmail** for the same window: attachments from billing senders,
   invoice and receipt subjects, and the sent folder for invoices raised. The
   heuristics are in [references/connectors.md](references/connectors.md).
4. **Report the sweep as a sweep**: how many documents from each source, which
   folders were read, which searches ran, and what could not be read. Zero
   receipts from a broken search is not "no expenses".
5. **Duplicates are kept, not dropped.** The same invoice from a Drive folder and
   from the mailbox it arrived in is a duplicate a person should see.

The sweep collects. It does not decide what is in scope beyond the period, and
it does not read the documents yet.

### B. Categorisation and reconciliation

1. **Read each document.** Vendor, dates, invoice number, currency, subtotal,
   tax, total, line items, payment method. A document that cannot be read is
   recorded as unreadable *with its filename* and goes on the open-items list.
   Never guess a total from a filename.
2. **Categorise against the chart** in
   [references/categories.md](references/categories.md), with a rationale from
   the document's own contents and a confidence. Anything landing in a category
   marked `alwaysReview` goes to a human whatever the confidence.
3. **Reconcile against the ledger.** Match on counterparty, date proximity and
   amount. Three outcomes: matched, document with no ledger entry, ledger entry
   with no document. A pairing where the amounts differ is *matched with a
   delta*, and the delta is reported, never rounded off.
4. **Flag.** Every discrepancy becomes an exception with the actual figures, the
   filenames, a severity and an action a person can take. "Check this" with no
   reason is a to-do the reviewer has to reconstruct, and they will skip it.

Escalate rather than queue when you see a fraud indicator, a backdated document
or a material unexplained gap. The rules file says concretely what each looks
like.

### C. Draft forms and package assembly

Three drafts, all of them arithmetic over the categorised documents:
**schedule-c**, **1099-nec-summary**, **1040-es-worksheet**. What feeds which
line, why meals reach the return at half, and why depreciation and the home
office carry nothing to their lines is in
[references/forms.md](references/forms.md).

The package leads with what is still open, then the totals, then the document
index. A pack that opens with a net profit invites someone to act on it; a pack
that opens with nine open items invites someone to work them.

Hand it to a **named** person, and never to the address that prepared it. A
second person reviewing before anything is filed is the whole point.

## 5. The companion web app

If `http://localhost:3000` answers, its HTTP API does all of the above against a
real register — documents, extractions, categorisations, the ledger, matches,
exceptions, drafts, packages and an append-only audit trail — one call each.
See [references/app-api.md](references/app-api.md). Prefer it when it is there:
it writes the record and the audit row in the same step, and it enforces the
rules in code rather than in a prompt. There is no environment variable for the
base URL; if it runs elsewhere, ask once and use that for the session.

The app and this skill are **separate registers**. A document you read from
Drive is not in the app until it is ingested there, and a finding the app raised
is not something a sweep can see. Say which one an answer came from.

Neither Drive nor Gmail is wired into the app in this build: its corpus is the
generated fixtures. Be honest about that everywhere.

| The user wants to | Do this |
|---|---|
| Know where the period stands | `GET /api/status`. Lead with open exceptions by severity, not with the money. `sources[]` says which sweeps ran; `available: false` is an absent connector, not an empty source. Money figures are `null` until the step that produces them has run — `null` is not zero. |
| Start a quarter | Establish entity, period, basis and currency first. Then sweep, ingest, extract, categorise, import the ledger, reconcile, detect. In that order — each step reads the one before. |
| Find what is missing | The reconciliation's ledger-only side plus `missing-support` and `missing-period` findings. Name the vendor, the amount and the date for each. |
| Know why something was flagged | `GET /api/exceptions`. Read out the detail verbatim — it carries the figures — then the suggested action. |
| Close a flag | You cannot. Say which screen does it, whether it is `resolved` or `accepted` (they mean different things), and draft the note the person will have to type. |
| Change a document's category | You cannot. `POST /api/classify/override` is a human action needing a note; the model's answer is kept beside theirs, not overwritten. |
| Know what a document says | Read the extraction. Quote the vendor, the filename and the figure every time, never "the invoice". |
| See the totals for a category | `GET /api/categories`, which carries `recorded` and `deductible` per category. They differ where `deductiblePct` does, and the difference is a statutory limit, not a discrepancy. |
| Draft the forms | `POST /api/forms`. Every line that was adjusted says why. Quote nothing off one without the word draft. |
| Assemble the package | `POST /api/packages`, then `POST /api/packages/handoff` to a named reviewer. It records the handoff; it sends no mail and it files nothing. |
| File the return | Not available, to you or to the app. Say the package is ready for review and name the reviewer. |
| Read the history | `GET /api/audit`. Append-only, refusals in it too. |
| Chase a missing invoice | Draft the request to the vendor with the dates and amounts exactly as recorded. Never invent an invoice number — a request naming an invoice that does not exist gets a confused reply and no invoice. |

Three rows in that table end at a human by design: **filing**, **closing a
finding** and **overriding a category**. That is not a permission you can be
granted; the tools do not exist.

For a request spanning several — "get Q1 ready for the accountant" — work them in
sequence and report each, rather than answering across all of them at once.

## 6. Work through the Tax Prep Console artifact

In the **Claude app** or on claude.ai there is **one** artifact for this
toolkit — a single **Tax Prep Console** page — and this skill is its backend. Do
not publish an artifact per question: find the existing one, refresh the part
the user asked about, and republish it to the same URL.

**Build or update it for every substantive answer**, not only long ones. A
missing connector, a period nobody has read and a quarter with nine open items
are all states the page draws, so a thin result is a reason to render it rather
than a reason to fall back to prose. Reply in text only for a single fact, or in
a terminal, where there is no artifact viewer.

Start from [references/tax-console.html](references/tax-console.html): everything
renders from the one `DATA` object at the bottom, and the rules and the `DATA`
contract are in `references/artifact.md`. The page's own header comment states
the distinction it exists to keep: **a key you did not fetch is absent, and a
key you fetched and found empty is `[]`.** Handing a section `[]` because a read
failed draws a clean quarter.

Lead with the source strip and the open items. A page whose figures arrive
before its unresolved findings invites somebody to act on the figures.

**No control on that page may file, submit, sign or close a finding.** It can
show what is open and copy a note for a person to paste. That is the line.

## 7. Ask with the question form, not prose

**Every question you put to the user goes through the tappable question tool.**
Not just the ones with options in them — every one. If you are about to end a
sentence with "?" and then wait for an answer, that is a question, and it goes
in the form.

Its name differs by surface: **`ask_user_input_v0`** in the Claude app,
**`AskUserQuestion`** in Claude Code. Use whichever is in your toolset. Not
finding one exact name is not a reason to fall back to prose — check for the
other, and failing both, use a numbered list.

| You need to know | Offer as options |
|---|---|
| Which period | The real periods in the workspace, with their dates and status — "2025 Q1, 1 Jan to 31 Mar, open" |
| Which entity | The entities actually configured, never a blank field |
| Which document | The real ones that match, by filename with vendor and amount — never a bare `doc_f27` |
| Which exception | The real open ones, by title with the figure in it, highest severity first |
| How to close one | Resolved (the problem was fixed) and accepted (a person looked and it is fine), each spelled out — plus reopen where that applies |
| Which category, when a document is ambiguous | The two or three real candidates with what belongs in each, plus the `alwaysReview` ones marked as going to a human either way |
| Who the package goes to | The configured tax manager, then the other named reviewers. Never the preparer address |
| Which folder or mailbox to sweep | The real folders found under the period, with their file counts |
| A note or a summary | Two or three drafted candidates, not an empty box |

Phrases that mean you got it wrong: "Could you clarify…", "Which one did you
mean?", "Let me know if…", "Do you want me to…", "Please provide…". Every one of
those is a form you did not build.

- **Never ask what you can determine.** Read the status, the register and the
  connector state first. A question you could have answered yourself is friction.
- **Every option states its consequence.** "Assemble — 39 documents, 9 items
  still open, marks the period packaged" beats "yes". Never a bare yes/no.
- **Recommend one, and put it first**, with the reason.
- **Anything irreversible is confirmed this way** — assembling, handing off,
  removing a document, importing over a ledger — never assumed from context.
- **One question at a time.** Several things missing means several forms in
  sequence, not one numbered list of fields.
- **Fetch before you ask.** Offer the real documents, the real findings, the real
  periods, labelled recognisably. Making someone go and look up an id you could
  have fetched makes them leave the conversation to answer you.

This binds on the first turn too. Invoked with no request, never open with "what
would you like to do?" — read the state, show what is open and what is missing,
then put the next step in the form.

**One exception, and it is absolute: never offer to file.** Not as an option,
not as a default, not as "shall I just submit it". There is no such option to
put in a form, and phrasing it as a question does not create one.

**And never put a deductibility opinion among the options.** "Deductible" /
"Not deductible" is not a choice you may offer, and neither is "capitalise" /
"expense" or "80% business use". Those go to the tax manager with the document
attached. What you may offer is which category records it, who decides, and what
note to attach while it waits.

## 8. When something fails

Get the reason out of the payload before reporting anything. The failure modes
here have different fixes and different consequences:

| What you see | What it is | What it means for the answer |
|---|---|---|
| The Drive folder cannot be listed | Connector or permission problem | The document side is unknown. Not "no documents". |
| A Gmail search returns nothing | Could be a genuine empty result, could be a wrong query | Say which query ran, so a person can tell the two apart. |
| A file will not open or has no text | An image-only scan, or a broken file | `unreadable`, with the filename, on the open-items list. Never a zero in a total. |
| `400` from an app route changing a record | The required note was blank | Write the note. Every such route rejects a blank one. |
| `503` from an app model route | `ANTHROPIC_API_KEY` is not set | Nothing was read. The corpus is not half-read, it is unread. |
| The app is unreachable | It is not running | Say so, and say the register was not consulted. |

Never convert a failure into a shrug. "I could not read the March folder, so the
March expenses are unknown" is useful. Silence reads as a clean quarter, and a
clean quarter is what somebody files.
