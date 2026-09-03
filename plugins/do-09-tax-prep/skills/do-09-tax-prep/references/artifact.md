# The Tax Prep Console artifact

There is **one** artifact for this toolkit — a single Tax Prep Console page —
and this skill is its backend. Never publish one artifact per question: you keep
updating the same page.

In the Claude app and on claude.ai, work through it. In a terminal there is no
artifact viewer, so answer in text.

## The loop

1. **Find the console.** If this conversation already published it, republish to
   the same file path. If not, list the user's artifacts and look for the one
   titled **Tax Prep Console**; pass its `url` so the update lands on it. Read it
   before you publish over it.
2. **Only create one when none exists.** Start from
   [`tax-console.html`](tax-console.html) beside this file.
3. **Run the skill.** Fetch what the user asked for — the app's HTTP API when the
   console is running, your own tools and connectors when it is not. That is the
   backend.
4. **Fill `DATA` and republish.** The page renders entirely from one `DATA`
   object at the bottom of the file. Replace it, keep everything above it, and
   publish to the same URL.

The page is the interface; you are the runtime behind it. A question about what
is still flagged updates `data.exceptions` and republishes — it does not produce
a second artifact.

The `DATA` block the template ships with is a real refresh of Northwind Studio
LLC, 2025 Q1. It is there so the page can be read before it is filled in, and it
is meant to be replaced wholesale. You do not need to read it to replace it.

### Where each key comes from, when the app is up

| Key | Endpoint |
|---|---|
| `overview` | `GET /api/status` — counts, money, period, sources |
| `documents` | `GET /api/documents` — one `DocumentView` per row |
| `categories` | `GET /api/categories` — the chart with `recorded`, `deductible`, `docCount` |
| `reconciliation` | `GET /api/reconcile` — `matched`, `documentOnly`, `ledgerOnly` |
| `exceptions` | `GET /api/exceptions` |
| `forms` | `GET /api/forms` |
| `package` | `GET /api/packages`, then `GET /api/packages?id=<id>` for the markdown |

All seven are GETs. Nothing you do to fill this page changes a record.

## The DATA contract

Every key is optional, and **absent means something different from empty**:

- A key you did not fetch → leave it **out**. The section renders "not loaded
  yet", and says in as many words that this is not a result.
- A key you fetched that has nothing in it → set `[]`. The section renders
  "nothing here".

Those must never look alike, which is the single most important rule in this
page. Do not fill a section with `[]` because a fetch failed, and do not fill one
with `[]` because a pipeline step has not run yet. A category chart of `[]`
renders as a quarter with no trading in it, and somebody will read it that way.

```js
DATA = {
  updated: "ISO timestamp of this refresh",
  sources: [{ name, does, connected, detail }],   // see below — THREE states
  alerts: [{ level: "error"|"warn"|"info", text }],
  data: {
    overview: {
      period: { label, entity, start, end, jurisdiction, basis, currency, status },
      stats: [{ label, value }],                   // value: null if not computed
      money: { currency, grossReceipts, totalExpenses, deductibleExpenses, unclassified },
    },
    documents: [{
      filename, source, vendor, issueDate, amount, currency,
      category, confidence, status, flags,
    }],
    categories: [{
      name, kind, formLine, recorded, deductible, currency, docCount, note,
    }],
    reconciliation: {
      matched:      [{ filename, vendor, entryDescription, counterparty,
                       docAmount, entryAmount, currency, delta, reasons }],
      documentOnly: [{ filename, vendor, issueDate, amount, currency, reasons }],
      ledgerOnly:   [{ date, description, counterparty, account, amount,
                       currency, ref, reasons }],
    },
    exceptions: [{
      kind, severity, title, detail, suggestedAction, status,
      documents, ledgerEntries, amount, currency,
      resolvedBy, resolvedAt, resolutionNote,
    }],
    forms: [{
      formId, formName, generatedAt, disclaimer,
      lines: [{ line, label, recorded, amount, currency, docCount,
                adjustmentNote, openExceptionIds }],
      totals: [{ label, amount, currency }],
      openExceptions: [ "…" ],                     // human-readable, one per line
      unmapped: [ "…" ],
    }],
    package: { counts, openItems, summary, markdown },
  },
}
```

### Key by key

**`updated`** — the moment of *this* refresh, not the moment a figure was
computed. Absent prints "never refreshed", which is honest about a page nobody
has filled in.

**`overview.period`** — everything in this product is scoped to one filing
period, and the page says which in its header. A figure with no period on it is a
figure somebody will read against the wrong quarter.

**`overview.stats[].value`** — `null` for anything you could not compute. Never
`0`, never a guess. Zero extracted documents and no extraction run are different
answers and only one of them is a finding.

**`overview.money`** — `grossReceipts`, `totalExpenses`, `deductibleExpenses`
and `unclassified` are each `null` until categorisation has run. The status
endpoint already returns them as `null` for exactly this reason; pass the `null`
through rather than substituting a zero.

**`documents[].amount`** — absent where the extraction produced no total. The
page prints an em dash. See the unreadable rule below.

**`documents[].confidence`** — the model's confidence in *reading the page*, not
in the categorisation being right and not in the expense being deductible. The
page says so above the table, because a high number in a column headed
"confidence" is otherwise read as a verdict.

**`documents[].category`** — absent until the document is categorised. It renders
"not categorised", which is a state, not a blank.

**`documents[].flags`** — the `kind` of each exception touching the document,
short. Long sentences belong in `exceptions[].detail`.

**`categories[].recorded` vs `.deductible`** — recorded is what the documents add
up to; deductible is what reaches the form line. Where they differ, `note` says
why in words (meals at 50%, business-use fraction). A draft that puts the receipt
total on the line is wrong while every document behind it is right, which is the
hardest kind of error to catch in review, so both figures are always shown.

**`reconciliation.matched[].delta`** — the difference between the document and
the ledger entry, to the cent, signed. Never round it, never omit it, never
"resolve" it by picking one of the two figures. The difference is the finding.

**`exceptions[].suggestedAction`** — what would close it, addressed to the
reviewer. A flag with no suggested action is a to-do the reviewer has to
reconstruct, and they will skip it. The page flags its absence.

**`forms[].disclaimer`** — print it on every rendering. The page falls back to
the standing text and flags the omission if it is missing, because a draft that
does not say it is a draft is the one page somebody files from.

**`package.markdown`** — the whole pack as markdown, so the reviewer can copy it
into the mail they send. The page shows it, and copies it. It does not send it.

**`alerts`** — where a cross-cutting problem goes: a pipeline step that has not
run, a sweep whose result predates the documents it should have seen, an
unreadable document with no flag against it, a tax-manager address that is not
set. If you leave a key out, say in an alert *why* it is out. "Not loaded yet"
tells the reader that something is missing; the alert tells them what to do.

## Four states the page must never flatten

These are the reason this page exists rather than a paragraph of prose. Get them
wrong and the console actively misleads.

### A draft is not a filing

Every form rendering carries the word DRAFT and the disclaimer, every time,
including in anything you copy out of the page. No control on the page may ever
be labelled File, Submit, E-file, Sign or Approve. There is no such control
anywhere in this product, and adding one to a shareable HTML page would be the
one way to defeat the only guarantee the product makes.

### Open, accepted and resolved are three states, not three shades

- **`open`** — nobody has looked at this yet.
- **`accepted`** — a person looked and judged it fine. **The difference is still
  there.** The figures did not change. An accepted flag rendered like a resolved
  one tells the next reader that something was fixed when nothing was.
- **`resolved`** — the underlying problem was fixed.

Closing one is a person's action in the console: a dialog that states the
consequence plus a required typed note that lands in the audit trail. Pass
`resolvedBy`, `resolvedAt` and `resolutionNote` on anything closed. A closure
with no note is a row saying somebody dealt with this and nothing about what they
did; six months on that is indistinguishable from nobody having looked, and the
page flags it as such.

### An unreadable document is not a document with a zero total

`status: "unreadable"` is a first-class outcome, not an error and not a missing
row. Keep the document in `documents` under its own filename, leave `amount`
absent so the page prints an em dash, and let the page say that nothing was read
from it. A scan dropped from the corpus so the counts look clean is the failure
this whole product exists to prevent, and a zero in its place is the same failure
with a number on it.

### Not loaded yet is not nothing here

Restated because it is the one that gets broken by accident. If categorisation
has not run, omit `categories`, `forms` and `package` — do not pass the empty
arrays the endpoints return. If a fetch failed, omit the key and put the failure
in `alerts`.

## Sources, always visible

The strip at the top is not decoration. Not knowing *which* source was read is
the commonest confusion, and here it is load-bearing: a page that cannot say
whether Drive was swept is a page whose empty document table means nothing.

Name what each source contributes — Google Drive for the finance folder, Gmail
for invoices that only ever arrived as an attachment, console uploads, the
generated corpus, the read-only accounting ledger, the model that reads the
pages.

**Never put a credential in the page.** Artifacts are shareable HTML; the console
shows connection *state*, never a token, and never an unmasked EIN.

### `connected` has three states, not two

`true`, `false`, or **`null` / omitted meaning "not checked this refresh"**.
Setting `false` for a source you simply did not query prints "not available" over
a working one and sends the user off reconnecting something that was never
broken — and worse, it hands them a ready-made explanation for an empty table
that is not the real one.

- Queried it and it answered → `connected: true` (renders "Available")
- Queried it and it is genuinely not there → `connected: false`
- **Did not query it this turn → `connected: null`**

`detail` carries the sub-state, because a source can be present while the sweep
behind it has not run: `detail: "Google Drive is not wired into this build, so no
sweep has run against it and the figure is unknown rather than zero."` That is a
different problem from a broken connector, and it is fixed differently.

## What the page may and may not do

The console is a **snapshot with a live interface**: tabs, a text filter on the
long tables, relative times in the viewer's timezone, copy buttons. All of that
runs locally.

It does **not** call anything. Its action is "Copy for Claude" — text comes back
to you and you do the work. Never label a control File, Submit, Approve, Resolve
or Override, and never let the page imply that something reached the app, the
ledger or a tax authority.

The page does make one judgement of its own, and it is a refusal rather than a
correction: if `reconciliation.matched` and `.documentOnly` both come back empty
while documents are loaded, it says the reconciliation has not seen the documents
instead of rendering a clean result. It does not repair the data — it names what
is wrong with it, which is what this product does everywhere else too.

## Turning on live actions

The page can call the viewer's connectors itself. Two things must both be true:

1. **You have observed the tool's real request and response in this session.**
   The runtime contract carries the call envelope, never a tool's argument names
   or result encoding. A guessed shape fails at the user's click — the worst
   place to discover it.
2. **You fill `LIVE` and declare the matching capability at publish time.**

```js
LIVE = {
  enabled: true,
  actions: {
    requestDocument: {
      server: "gmail",
      tool: "<observed tool name>",
      args: ({ vendor, amount, period, ledgerRef }) => ({ /* the shape you observed */ }),
    },
  },
}
```

**And one rule that overrides both: a live control may never file, submit, sign,
resolve an exception, accept one, override a category or hand off a package.**
The page may *raise a request* — draft a mail to a vendor asking for the missing
invoice behind a `missing-support` flag — and it may *copy a decision* for a
person to carry out. Anything that changes the record goes through a named human
in the console, with a dialog stating the consequence and a typed note in the
audit trail. A button on a shareable HTML page is not a named human, and it
cannot type the note.

Errors branch on the error **code**, never the message: `needs_reauth` says
reconnect, `server_not_connected` says add the connector, `rate_limited` says
wait. The page still renders and stays useful when the capability resolves
`null`; live controls simply do not appear.

## The Ask tab — running the skill's behaviour in the page

**No capability invokes a Claude skill.** A skill loads into a chat turn, and a
page cannot start one. What the console does instead is run the skill's
*behaviour*: `sample` gives the page Claude, and its `tools` are page functions
that reach the same connectors through `mcp`. Add the tab to `TABS` and a matching
entry to `PANELS` when you wire it in.

```js
ASSIST = {
  enabled: true,
  rules: "<references/rules.md, inlined here>",
}
```

Claude-in-the-page has **no memory and no skill loaded**, so everything that
governs it goes in `rules` — the same contract the chat-side skill follows and
the same file `src/lib/skills.ts` reads into the app agent's system prompt, so
all three surfaces behave identically. That includes the three invariants: the
in-page assistant reads, reconciles and drafts, and it does not file, does not
silently adjust a figure to make a total agree, and does not decide
deductibility. Uncertain categorisations go to the tax manager with the document
attached, in the page exactly as in the conversation.

The viewer pays for these calls and the first one asks consent, so it only fires
on a click, never on load. `onText` delivers the whole answer so far — assign it,
never append.

## Publishing

Title stays **Tax Prep Console**; keep the favicon it was created with. Pass a
`description` saying what this refresh contains — the period, and what is open —
so the gallery card is useful: "Northwind Studio LLC, 2025 Q1: 39 documents, 39
open flags, no draft forms yet." Do not rename it per question. One console, one
identity, updated in place.
