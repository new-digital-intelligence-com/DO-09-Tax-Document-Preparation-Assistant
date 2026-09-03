# The three drafts

Written from `src/lib/forms.ts`. That file is the truth; this one explains what
it does and why.

Three drafts come out of a prepared period:

| `formId` | What it is |
|---|---|
| `schedule-c` | Schedule C (Form 1040) — Profit or Loss From Business. Income and expense lines rolled up from the categorised documents. |
| `1099-nec-summary` | Contract labour by counterparty: who was paid, who crosses the annual reporting threshold, who has no tax identification number on file. A worksheet for whoever files the 1099s. It is not a 1099. |
| `1040-es-worksheet` | Estimated tax. Self-employment tax worked from the Schedule C draft's net profit. The income-tax line is left blank on purpose. |

## Every one of them is a draft, and stays one

`FormDraft.status` is typed as the literal `"draft"`. There is no other value,
so there is no code path in this repo — or mistake in it — that can produce
anything else. That is a stronger guarantee than a sentence in a prompt.

Every rendering carries the same disclaimer, verbatim and not parameterised:

> DRAFT — prepared by DO-09 from the documents listed. Figures are as extracted,
> not as advised. Nothing here has been filed, and no line is final until a tax
> professional has reviewed it against the open items.

Quote no figure off one of these without the word draft attached to it. A number
read out of context becomes a number somebody repeats to their accountant.

## No model computes any of it

There is no model call in `forms.ts` and there must never be one. Every figure
is arithmetic over the category totals, for a narrow reason: **a total a model
computed is a total nobody can check.** A reviewer holding a receipt can follow
a sum back through `categoryTotals` to the documents that made it. They cannot
follow a sentence back to anything.

The model's work finished at extraction and categorisation, both of which a
person can audit document by document. Addition is not the part that needs
intelligence.

## Schedule C — which categories feed which line

Lines are keyed by `TaxCategory.lineKey`, never by category id. A category added
to the chart with an existing `lineKey` lands on the right line with nobody
editing `forms.ts`; a category added with a *new* `lineKey` lands nowhere, shows
up in `unmappedCategoryIds`, and says so on the draft. That is the failure mode
to want — a default line would quietly absorb money nobody mapped.

| Line | Label | Fed by |
|---|---|---|
| 1 | Gross receipts or sales | `income-services`, `income-product` |
| 2 | Returns and allowances | `income-refunds` |
| 3 | Subtract line 2 from line 1 | computed |
| 4 | Cost of goods sold (from line 42) | `cogs-purchases`, `cogs-materials` |
| 5 | Gross profit | computed |
| 6 | Other income | `income-other` |
| 7 | Gross income | computed |
| 8 | Advertising | `expense-advertising` |
| 9 | Car and truck expenses | `expense-vehicle` |
| 10 | Commissions and fees | `expense-commissions` |
| 11 | Contract labor | `expense-contract-labor` |
| 13 | Depreciation and section 179 | `expense-depreciation` — **carries nothing** |
| 15 | Insurance (other than health) | `expense-insurance` |
| 16b | Interest — other | `expense-interest` |
| 17 | Legal and professional services | `expense-professional` |
| 18 | Office expense | `expense-office` |
| 20a | Rent or lease — vehicles, machinery, equipment | `expense-rent-equipment` |
| 20b | Rent or lease — other business property | `expense-rent-property` |
| 21 | Repairs and maintenance | `expense-repairs` |
| 22 | Supplies | `expense-supplies` |
| 23 | Taxes and licenses | `expense-taxes-licenses` |
| 24a | Travel | `expense-travel` |
| 24b | Deductible meals | `expense-meals` — **at 50%** |
| 25 | Utilities | `expense-utilities` |
| 26 | Wages | `expense-wages` |
| 27a | Other expenses | `expense-training`, `expense-bank-fees`, `expense-other` |
| 28 | Total expenses before business use of home | computed |
| 29 | Tentative profit or loss | computed |
| 30 | Expenses for business use of your home | `expense-home-office` — **carries nothing** |
| 31 | Net profit or loss | computed |

Every line carries `recorded` and `amount` separately, plus `categoryIds`,
`docCount` and `openExceptionIds`. A line with open exceptions against it is not
final, and the line itself says which ones.

### Line 2 reads backwards unless the note is read

Credit notes are recorded as **positive** figures on line 2 and subtracted on
line 3. The line carries a note saying exactly that, whether or not the
arithmetic adjusted anything, because a reader who takes line 2 for an expense
has misread the return by twice the number.

### The 50% meals rule

`expense-meals` carries `deductiblePct: 0.5`. The receipt total goes to
`recorded`; half of it goes to `amount`; the line's `adjustmentNote` names both
figures and the percentage, in this shape:

> Business meals reaches the line at 50 per cent: 1,240.00 recorded across 9
> documents, 620.00 on the line. The difference is the statutory limit, not a
> discrepancy in the receipts.

That last clause is the point. A reviewer who sees two different numbers and no
explanation goes looking for a missing receipt that does not exist. A draft that
put the receipt total on the line would be wrong while every document behind it
was right, which is the hardest error in this product to catch.

### Why line 13 and line 30 carry nothing

Both are real money, both are recorded, and neither reaches its line.

**Line 13, depreciation.** `expense-depreciation` is `kind: "asset"`, so
`deductibleFraction` returns zero. Equipment above the capitalisation threshold
is capitalised and depreciated; the deductible figure comes from Form 4562 or a
section 179 election. Whether to capitalise, take de minimis treatment, or elect
179 is a decision with multi-year consequences and it is not the assistant's.
The line's note says so and names the recorded total, so the money is visible
and unclaimed rather than invisible.

**Line 30, home office.** The chart calls it a full-fraction expense because the
*category* is deductible. `lineFraction()` in `forms.ts` overrides it to zero,
and the comment there says why: the allowable claim is computed on Form 8829
from an exclusive-use square footage that no document in the workspace states.
Carrying the household bills straight to line 30 would put a figure on a return
that nothing in this app can justify.

The shape is the same in both: **recorded and shown, not carried.** Nobody signs
a number this app invented.

### `unmappedCategoryIds` and the fourth total

Schedule C's totals block carries an unusual fourth row: *Recorded but on no
line of this form*. It is the money in categories whose `lineKey` no Schedule C
line accounts for — health premiums, owner draws, personal spend, income tax,
and anything sitting in `uncategorised`.

A form that silently dropped that pile would balance perfectly and be missing
whatever was in it. Report the figure whenever you report net profit.

## The 1099-NEC summary

One row per counterparty, over documents categorised `expense-contract-labor`,
sorted by amount. `recorded` is what was paid in the period; `amount` is what
would be reported on a 1099-NEC on these figures, which is **nothing for a
vendor under the threshold** (`Settings.contractor1099Threshold`, 600.00 by
default). Keeping both is what stops a row reading as "this contractor was not
paid".

Three things it refuses to smooth over:

- **The threshold is annual and the period is a quarter.** A vendor under it here
  can cross it by December, and the row says so rather than reading as a
  decision that no 1099 is due.
- **A document with no vendor name gets its own row**, never folded into a
  neighbouring name. Guessing which contractor an unnamed invoice belongs to is
  how a payment lands on the wrong person's 1099.
- **Documents it could not size get a row with a zero on it** — foreign currency
  and unreadable totals — rather than no mention at all. Leaving them out makes
  the totals look complete, which is the only way this table can mislead.

The label carries the tax-ID fact — "Raman Consulting — no tax ID on file" —
because a reviewer chasing W-9s needs it on the row they are reading, and it is
true of the vendor whether or not any amount was adjusted. Never print the
number itself; whether one is on file is the finding.

Exceptions of kind `contractor-1099-threshold` and `missing-vendor-tax-id` are
attached to this draft wherever they were raised, because a missing W-9 is this
worksheet's problem regardless of which category the document sits in.

## The 1040-ES worksheet

| Line | What it is |
|---|---|
| 1 | Net profit carried from the Schedule C draft, line 31 |
| 2 | Net earnings subject to self-employment tax — 92.35% of line 1 |
| 3 | Self-employment tax at 15.3% of line 2 |
| 4 | Deductible half of line 3 — an adjustment on Schedule 1, not a Schedule C expense |
| 5 | Estimated income tax — **left blank** |

Every line states its assumptions in its own note, and they are load-bearing:
line 2 assumes all the net profit is self-employment earnings; line 3 assumes the
whole of line 2 falls below the Social Security wage base and that no wages from
other employment have used part of it, and assumes no Additional Medicare Tax.
Where an assumption is wrong the figure is high or low, and a person has to say
which.

**Line 5 is blank on purpose, and there is no grand total.** Income tax depends
on filing status, a spouse's income, other household income, deductions, credits
and payments already made — none of which this app holds and none of which
appear on an invoice. A zero there would read as "no income tax due", and a
reviewer skimming a worksheet that already got the hard-looking self-employment
figure right has every reason to believe it. A total computed with a blank in it
is not a total.

The worksheet recomputes Schedule C from the same context rather than reading a
stored draft, so the net profit it quotes can never be last week's.

## What a reviewer must supply that the app cannot

Hand this list over with the pack. Every item is a fact no document in the
workspace states:

| Missing fact | Why it is not here | What it blocks |
|---|---|---|
| Capitalise, de minimis, or section 179 | A multi-year decision, not a reading of a receipt | Line 13, and the true net profit |
| Exclusive-use square footage | No receipt states it; it is computed on Form 8829 | Line 30 |
| Business-use fraction of shared phone, internet, vehicle | Not printed on any bill | Lines 9 and 25 |
| Standard mileage or actual vehicle costs | The methods give different figures and cannot be mixed year to year | Line 9 |
| Prior-year depreciation schedule and basis | Belongs to last year's return | Line 13 |
| Opening and closing inventory | Not in the document corpus | Lines 35 to 42, hence line 4 |
| Filing status, other household income, deductions, credits, payments made | Belongs to the 1040 preparer | Line 5 of the worksheet, and any total on it |
| Health insurance premium treatment | Schedule 1, not Schedule C, and limited by net profit | The off-form total |
| Whether an accepted exception is genuinely acceptable | It is a judgement about this business | Every line the finding touches |
| The signature | Nothing here files, submits or signs | The return itself |

## Reading a draft honestly

- Give the form name, the period and the word **draft**, every time.
- Give `recorded` and `amount` together wherever they differ, and read out the
  `adjustmentNote` rather than paraphrasing it. It carries the figures.
- Name the open items against the line before the figure on it. Line 31 with
  nine findings open is not a net profit, it is a working number.
- Never present the totals block without the fourth row: money on no line is
  still money.
- If a draft was generated before the last extraction or categorisation run, it
  is stale — regenerate rather than quoting it. Check `generatedAt` against the
  newest `extractedAt` and `classifiedAt` before you quote a figure off one, and
  regenerate all three when you assemble a package, so a pack can never carry a
  form that predates the categorisation behind it.
