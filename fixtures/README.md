# The fixture corpus

Thirty-nine PDFs, a thirty-eight row ledger, and a manifest that says what each
of them is supposed to be. Generated, not collected — but every defect in it is
a defect a real quarter produces, and none of them announces itself.

```
npm run fixtures     # rebuild fixtures/ from scripts/generate-fixtures.mjs
npm run seed         # load it into .data/ (refuses unless --force)
```

**Entity:** Northwind Studio LLC, a six-person design and development studio,
1180 Kettle Row, Suite 4, Portland OR 97209. EIN 87-4419203.
**Period:** 2025 Q1, `2025-01-01` to `2025-03-31`, cash basis, USD, US federal.
**Period id:** `period_2025_q1`. **Document ids:** `doc_f01` … `doc_f39`.

Nothing in this corpus has been filed, and no figure in it is advice.

## Why it exists

The corpus is the test suite. Every `ExceptionKind` in `src/lib/types.ts` has at
least one document or ledger row engineered to raise it, and the expected
finding is written down beside the file in `manifest.json` so `npm run smoke`
can check the pipeline against a written answer rather than against whatever it
happened to produce that run.

Two rules shaped every document in it.

**The defects are real defects, not markers.** The Northgate invoice does not
say "total mismatch". It prints 900.00 + 72.00 = **927.00**, a transposition of
the last two digits, the slip a tired person makes on a hand-keyed invoice and
the one a reviewer's eye slides straight past. A fixture that announces its own
fault tests the reader, not the pipeline.

**`truth` is what a correct extraction returns, not an assertion.** A model that
reads `1,842.19` as `1842.19` has not made a mistake. The smoke script compares
numerically, and compares dates and vendor names case-insensitively, and reports
drift. It does not fail a build because a vendor came back as "AWS" rather than
"Amazon Web Services, Inc."

## The documents

| id | file | vendor | date | total | ccy | expected flags |
|---|---|---|---|---:|---|---|
| `f01` | `INV-2025-001 Acme Robotics.pdf` | Acme Robotics Inc. | 2025-01-08 | 12,500.00 | USD | — |
| `f02` | `INV-2025-002 Bluepeak Health.pdf` | Bluepeak Health Systems | 2025-01-15 | 8,400.00 | USD | — |
| `f03` | `INV-2025-003 Cormorant Ventures.pdf` | Cormorant Ventures LP | 2025-02-04 | 15,000.00 | USD | — |
| `f04` | `INV-2025-004 Acme Robotics.pdf` | Acme Robotics Inc. | 2025-02-08 | 12,500.00 | USD | — |
| `f05` | `INV-2025-005 Bluepeak Health.pdf` | Bluepeak Health Systems | 2025-02-15 | 8,400.00 | USD | — |
| `f06` | `INV-2025-006 Delta Freight Co.pdf` | Delta Freight Co. | 2025-03-06 | 6,750.00 | USD | — |
| `f07` | `INV-2025-007 Bluepeak Health.pdf` | Bluepeak Health Systems | 2025-03-15 | 8,400.00 | USD | — |
| `f08` | `CN-2025-001 Delta Freight credit note.pdf` | Delta Freight Co. | 2025-03-24 | −750.00 | USD | — |
| `f09` | `stripe-payout-statement-feb-2025.pdf` | Stripe | 2025-02-28 | 611.20 | USD | — |
| `f10` | `aws-invoice-jan-2025.pdf` | Amazon Web Services, Inc. | 2025-01-03 | 1,842.19 | USD | `ledger-amount-mismatch` |
| `f11` | `aws-invoice-feb-2025.pdf` | Amazon Web Services, Inc. | 2025-02-03 | 2,014.55 | USD | — |
| `f12` | `figma-organization-annual.pdf` | Figma, Inc. | 2025-01-11 | 1,080.00 | USD | — |
| `f13` | `google-workspace-jan.pdf` | Google LLC | 2025-01-02 | 180.00 | USD | — |
| `f14` | `google-workspace-feb.pdf` | Google LLC | 2025-02-02 | 180.00 | USD | — |
| `f15` | `google-workspace-mar.pdf` | Google LLC | 2025-03-02 | 180.00 | USD | — |
| `f16` | `wework-jan-2025.pdf` | WeWork | 2025-01-01 | 1,400.00 | USD | — |
| `f17` | `wework-feb-2025.pdf` | WeWork | 2025-02-01 | 1,400.00 | USD | — |
| `f18` | `wework-mar-2025.pdf` | WeWork | 2025-03-01 | 1,400.00 | USD | — |
| `f19` | `statefarm-business-liability.pdf` | State Farm | 2025-01-20 | 1,260.00 | USD | — |
| `f20` | `harbor-legal-llp-invoice-2291.pdf` | Harbor Legal LLP | 2025-02-19 | 950.00 | USD | — |
| `f21` | `staples-receipt-2025-02-11.pdf` | Staples | 2025-02-11 | 87.43 | USD | — |
| `f22` | `delta-air-eticket-2025-03-03.pdf` | Delta Air Lines, Inc. | 2025-03-03 | 612.40 | USD | — |
| `f23` | `hotel-folio-hyatt-sf.pdf` | Hyatt Regency San Francisco | 2025-03-05 | 884.00 | USD | — |
| `f24` | `receipt-cascade-kitchen.pdf` | Cascade Kitchen | 2025-03-04 | 214.60 | USD | — |
| `f25` | `adobe-cc-feb-2025.pdf` | Adobe Inc. | 2025-02-06 | 59.99 | USD | `duplicate-document` |
| `f26` | `Adobe_Invoice_ADB-88214 (1).pdf` | Adobe Inc. | 2025-02-06 | 59.99 | USD | `duplicate-document`, `unmatched-document` |
| `f27` | `northgate-print-invoice-4471.pdf` | Northgate Print Works | 2025-02-21 | 927.00 | USD | `total-mismatch` |
| `f28` | `hetzner-rechnung-2025-03.pdf` | Hetzner Online GmbH | 2025-03-05 | 89.00 | **EUR** | `currency-mismatch` |
| `f29` | `scan_20250312_receipt.pdf` | — | — | — | — | `unreadable-document`, `unmatched-document` |
| `f30` | `apple-store-invoice-w1882043.pdf` | Apple Inc. | 2025-01-28 | 2,899.00 | USD | `capitalisation-threshold`, `category-needs-judgement` |
| `f31` | `verizon-wireless-feb-2025.pdf` | Verizon Wireless | 2025-02-14 | 128.77 | USD | `category-needs-judgement` |
| `f32` | `wholefoods-2025-02-27.pdf` | Whole Foods Market | 2025-02-27 | 142.88 | USD | `possible-personal-expense`, `category-needs-judgement` |
| `f33` | `raman-consulting-invoice-0031.pdf` | Raman Consulting | 2025-01-22 | 4,500.00 | USD | `missing-vendor-tax-id`, `contractor-1099-threshold` |
| `f34` | `raman-consulting-invoice-0034.pdf` | Raman Consulting | 2025-03-10 | 3,200.00 | USD | `contractor-1099-threshold` |
| `f35` | `t-alvarez-invoice-mar.pdf` | Alvarez Motion | 2025-03-18 | 520.00 | USD | — |
| `f36` | `meridian-health-premium-q1.pdf` | Meridian Health Plan | 2025-01-05 | 1,842.00 | USD | `category-needs-judgement` |
| `f37` | `mileage-log-q1-2025.pdf` | Northwind Studio LLC | 2025-03-31 | — | — | `category-needs-judgement`, `unmatched-document` |
| `f38` | `koyo-studio-invoice-2024-1219.pdf` | Koyo Studio | **2024-12-19** | 1,650.00 | USD | `out-of-period`, `unmatched-document` |
| `f39` | `bright-anvil-invoice-0442.pdf` | Bright Anvil Labs | **2025-04-02** | 3,400.00 | USD | `backdated-document`, `contractor-1099-threshold` |

**`aws-invoice-mar-2025` is deliberately absent.** The ledger carries the March
AWS charge and no document supports it.

Layouts vary because real folders vary: a Stripe payout report, a hotel folio, a
Delta e-ticket, three till-roll receipts in Courier on a 288pt page, a German
`Rechnung` priced in euros, an insurance premium schedule, a wireless bill and a
mileage log with no money on it anywhere. Sources split 20 Drive, 14 Gmail, 5
hand-uploaded, so the source breakdown on the overview has real numbers in it.
Neither connector is wired in this build; the labels record where each document
*would have* come from.

## The ledger — `ledger-2025-q1.csv`

Header, exactly: `date,description,counterparty,amount,currency,account,ref`.
Thirty-eight rows. One per document except the four that could not have one
(the duplicate, the unreadable scan, the mileage log, the out-of-period
invoice), plus three rows with no document at all.

The divergences are the point:

1. **AWS January.** The ledger says `1,824.19`; the invoice says `1,842.19`. A
   transposition of the same two digits, an $18.00 delta, and the single finding
   the whole reconciliation module exists for.
2. **AWS March**, `2,190.44`, ref `INV-AWS-MAR25` — a ledger row with no
   document. `missing-support`, and because AWS billed January and February,
   `missing-period` as well.
3. **Ridgeline Coworking** day pass `45.00` and **Notion Labs** `96.00` — two
   more rows nobody kept a receipt for.
4. **Koyo Studio** has no ledger row: it belongs to the quarter before.
5. **Bright Anvil** is posted `2025-03-27` and invoiced `2025-04-02`.

Everything else pairs on amount and date within five days.

Two fields exercise the hand-written CSV parser rather than the happy path: a
description carrying a comma (`Amazon Web Services, Inc. — December usage`) and
one carrying doubled quotes (`Day pass, booked as ""team offsite""`). A parser
that drops either produces a ledger one row short, which reconciles cleanly and
hides a transaction that had no support.

## Exception coverage

Twenty-five distinct findings across fifteen of the sixteen kinds.

| kind | expected | raised by |
|---|---:|---|
| `duplicate-document` | 1 | f25 + f26, same sha256 |
| `total-mismatch` | 1 | f27, 900.00 + 72.00 printed as 927.00 |
| `ledger-amount-mismatch` | 1 | f10 against `INV-AWS-JAN25` |
| `missing-support` | 3 | `INV-AWS-MAR25`, `RC-DP-0218`, `NL-2025-03` |
| `unmatched-document` | 4 | f26, f29, f37, f38 |
| `unreadable-document` | 1 | f29 |
| `missing-period` | 1 | AWS: January, February, then a gap |
| `out-of-period` | 1 | f38, dated 2024-12-19 |
| `currency-mismatch` | 1 | f28, 89.00 EUR against a USD period |
| `category-needs-judgement` | 5 | f30, f31, f32, f36, f37 |
| `missing-vendor-tax-id` | 1 | f33, no tax id printed |
| `possible-personal-expense` | 1 | f32 |
| `capitalisation-threshold` | 1 | f30, 2,899.00 over the 2,500.00 threshold |
| `contractor-1099-threshold` | 2 | Raman 7,700.00; Bright Anvil 3,400.00 |
| `backdated-document` | 1 | f39 — **high, escalate to the tax manager** |
| `low-confidence-category` | — | model-dependent, see below |

`expectedFindings` in the manifest is the count the register should hold;
a document's `expectedExceptions` is the list of flags attached to that file.
They are different numbers and must not be summed together — one duplicate
finding names two files, and one 1099 finding names every invoice from that
contractor.

`low-confidence-category` is reachable — f29 and f37 give a classifier almost
nothing to work with — but whether it fires turns on a confidence score the
model chooses rather than on a fact printed on a page. Asserting on it would
fail the build for a reading that was not wrong, so the manifest records it
under `modelDependentExceptions` and the smoke script reports it as drift.

## The negative cases

A corpus that contains only defects trains the reader to expect one on every
page. These must come through clean, and `expectedClean` in the manifest says
so:

- **f35** — contract labour, tax id printed, 520.00 in the period. Below the
  600.00 threshold. Nothing should be raised.
- **f24** — business meals at 50%. The haircut is an adjustment note on a form
  line, not an exception.
- **f08** — a credit note is negative revenue, not an error. Schedule C line 2.
- **f09** — a payout report carries three figures. Only the 611.20 of processing
  fees is an expense; the 20,900.00 gross is revenue already invoiced.

## The PDF writer

`scripts/lib/pdf-lite.mjs` — PDF 1.4, from scratch, no dependencies.
Uncompressed content streams, base-14 fonts only (Helvetica, Helvetica-Bold,
Courier), WinAnsi text encoding with `€` at 0x80 and Latin-1 umlauts, a correct
`xref` table and `startxref` offset, line and rect primitives, and a `sketch()`
that emits path operators and nothing else.

Uncompressed matters: the generator verifies itself with a byte search, and a
fixture whose contents cannot be checked without a PDF library is a fixture
nobody checks. Deterministic output matters too — no timestamp, no random id —
because f25 and f26 have to hash identically on every run or the duplicate
fixture stops being a duplicate.

`scan_20250312_receipt.pdf` is the one file with **no text operators at all**.
It is a page of paths: creases, unreadable print bars, handwriting-shaped
scribbles, a signature and a thumb smudge. Nothing can be read off it, and
nothing should be guessed from its filename. Any extraction that returns a
vendor or a total for it has invented one.

## What was verified

Every run of `npm run fixtures` checks, and refuses to exit clean without:

- every file starts `%PDF-` and ends `%%EOF`, and carries a `startxref` offset;
- `scan_20250312_receipt.pdf` contains no `Tj` or `TJ` operator;
- every other file does contain text operators, and each one's key strings —
  vendor, invoice number, total — are findable in its uncompressed stream;
- f25 and f26 hash identically;
- the ledger has seven fields on every row, counting only the commas outside
  quotes;
- the manifest count matches the PDFs on disk;
- every exception kind is reachable from some fixture, bar the model-dependent
  one.

Checked once by hand with tools outside this repo: all 39 files open in
`mutool` and in `pypdf` with no warnings, text extracts from 38 of them, and
`scan_20250312_receipt.pdf` extracts nothing at all. The Hetzner invoice
round-trips `€`, `Industriestraße`, `Zusätzliche`, `Gebühren` and
`RECHNUNGSEMPFÄNGER` through both readers. `pdftotext` is not installed on this
machine, so that particular tool was not used.

## Seeding

`npm run seed` reads `manifest.json`, writes `.data/settings.json` (the filing
period and the entity, and nothing else — a value the seeder invents would
shadow the deployment's own environment on every future boot), writes
`.data/documents.json`, copies each PDF to `.data/documents/<id>.pdf` under its
stable id with a recomputed sha256, and imports the ledger into
`.data/ledger.json`. It refuses to run over a non-empty register without
`--force`.

It seeds **documents, the ledger and the period, and nothing else.** No
extractions, no categorisations, no matches, no exceptions, and one audit row
for the seeding it actually did. An invented extraction puts a figure in the
register that no model ever read off a document, and an invented audit row puts
an event in an append-only trail that never happened. Both are indistinguishable
from the real thing three screens later, which is exactly why neither is
written.
