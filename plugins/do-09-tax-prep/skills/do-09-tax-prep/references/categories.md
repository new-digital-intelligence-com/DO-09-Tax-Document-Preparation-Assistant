# The tax category chart

**Generated from `src/lib/categories.ts`. That file wins.** It is the contract
three things share — the classifier's prompt is built from it, the form mapper
rolls totals up by its `lineKey`, and this reference is written from it. A
category added there reaches all three; a category described only here reaches
nobody. If this table and the file disagree, the file is right and this table is
stale.

The jurisdiction is US federal, sole proprietor or single-member LLC, so the
lines are Schedule C (Form 1040). Swapping jurisdictions is a swap of
`categories.ts` and `forms.ts` — nothing else knows what a line number means.

Two fields do the work a flat list of names cannot.

**`deductiblePct`** is the one field that quietly changes a number. Meals reach
the return at 50%, so a draft that puts the receipt total on line 24b is wrong
while every document behind it is right — the hardest kind of error to catch in
review. Where it applies, the draft carries both figures: `recorded` is what the
documents add up to, `amount` is what lands on the line, and `adjustmentNote`
says why they differ in words.

**`alwaysReview`** routes a document to a human regardless of how confident
anything was, because the category itself is the judgement call. It is how rule
three is encoded. Seven categories carry it.

## The chart

`On the line` is `deductibleFraction()` from `categories.ts`, with one override
applied in `forms.ts` and noted where it bites.

### Income

| id | Name | Form line | `lineKey` | On the line | What belongs here |
|---|---|---|---|---|---|
| `income-services` | Service revenue | Schedule C, line 1 | `sc-1` | 100% | Fees invoiced to clients for services performed. The ordinary revenue line for a consultancy. |
| `income-product` | Product sales | Schedule C, line 1 | `sc-1` | 100% | Sales of goods or licences, as distinct from time billed. |
| `income-refunds` | Returns, credits and allowances | Schedule C, line 2 | `sc-2` | 100% | Credit notes and refunds issued to clients. Recorded positive here and subtracted from gross receipts on the form. |
| `income-other` | Other business income | Schedule C, line 6 | `sc-6` | 100% | Interest on business accounts, recoveries, and anything received in the course of business that is not a sale. |

### Cost of goods sold

| id | Name | Form line | `lineKey` | On the line | What belongs here |
|---|---|---|---|---|---|
| `cogs-purchases` | Purchases for resale | Schedule C, line 36 | `sc-36` | 100% | Goods bought to resell, and materials that go into what is sold. |
| `cogs-materials` | Materials and supplies (COGS) | Schedule C, line 38 | `sc-38` | 100% | Materials consumed producing what is sold. Distinct from office supplies, which are an operating expense. |

### Operating expenses

| id | Name | Form line | `lineKey` | On the line | What belongs here |
|---|---|---|---|---|---|
| `expense-advertising` | Advertising and marketing | Schedule C, line 8 | `sc-8` | 100% | Paid advertising, sponsorships, marketing tools and campaign spend. |
| `expense-vehicle` | Car and truck expenses — always review | Schedule C, line 9 | `sc-9` | 100% | Business mileage or actual vehicle costs. A mileage log is support, not a receipt — the rate is applied at form time. |
| `expense-commissions` | Commissions and fees | Schedule C, line 10 | `sc-10` | 100% | Referral commissions, agency fees, and payment-processor fees charged on revenue. |
| `expense-contract-labor` | Contract labour | Schedule C, line 11 | `sc-11` | 100% | Payments to non-employee contractors and freelancers. Feeds the 1099-NEC summary; the annual threshold is a setting. |
| `expense-insurance` | Insurance (other than health) | Schedule C, line 15 | `sc-15` | 100% | Business liability, professional indemnity, contents and cyber cover. Health premiums are not on this line. |
| `expense-interest` | Interest (business loans and cards) | Schedule C, line 16b | `sc-16b` | 100% | Interest on business borrowing and business credit cards. |
| `expense-professional` | Legal and professional services | Schedule C, line 17 | `sc-17` | 100% | Solicitors, accountants, bookkeepers, company formation and filing agents. |
| `expense-office` | Office expense | Schedule C, line 18 | `sc-18` | 100% | Software subscriptions, cloud hosting, domains, postage and general office running costs. |
| `expense-rent-equipment` | Rent or lease — vehicles and equipment | Schedule C, line 20a | `sc-20a` | 100% | Leased machinery, equipment and vehicles. |
| `expense-rent-property` | Rent or lease — business property | Schedule C, line 20b | `sc-20b` | 100% | Office rent, coworking desks and storage. |
| `expense-repairs` | Repairs and maintenance | Schedule C, line 21 | `sc-21` | 100% | Keeping equipment and premises working. Improvements are capitalised instead. |
| `expense-supplies` | Supplies | Schedule C, line 22 | `sc-22` | 100% | Consumables used in the business — stationery, printer supplies, small tools. |
| `expense-taxes-licenses` | Taxes and licences | Schedule C, line 23 | `sc-23` | 100% | Business licences, registration and franchise fees, and employer payroll taxes. Income tax is not deductible here. |
| `expense-travel` | Travel | Schedule C, line 24a | `sc-24a` | 100% | Business travel away from the tax home — flights, hotels, ground transport. |
| `expense-meals` | Business meals | Schedule C, line 24b | `sc-24b` | **50%** | Meals with a business purpose. Reaches the return at 50% of the recorded amount; the draft shows both figures. |
| `expense-utilities` | Utilities — always review | Schedule C, line 25 | `sc-25` | 100% | Business phone, internet and power. A line shared with a household is apportioned, not claimed in full. |
| `expense-wages` | Wages | Schedule C, line 26 | `sc-26` | 100% | Payroll for employees, excluding amounts paid to the owner. |
| `expense-training` | Training and professional development | Schedule C, line 27a | `sc-27a` | 100% | Courses, conferences, books and memberships that maintain existing skills. |
| `expense-bank-fees` | Bank and merchant fees | Schedule C, line 27a | `sc-27a` | 100% | Account charges, wire fees and card scheme costs not netted off revenue. |
| `expense-other` | Other business expenses | Schedule C, line 27a | `sc-27a` | 100% | Ordinary and necessary business costs no other line describes. Itemised on the draft. |
| `expense-home-office` | Home office — always review | Schedule C, line 30 (via Form 8829) | `sc-30` | **nothing** | Household costs apportioned to a dedicated work space. Computed on Form 8829, not claimed from a receipt. |

### Capitalised — never a straight deduction

| id | Name | Form line | `lineKey` | On the line | What belongs here |
|---|---|---|---|---|---|
| `expense-depreciation` | Depreciation and section 179 — always review | Schedule C, line 13 | `sc-13` | **nothing** | Durable equipment above the capitalisation threshold. Capitalised and depreciated, never expensed in full without an election. |

### Recorded, and not deductible here

| id | Name | Form line | `lineKey` | On the line | What belongs here |
|---|---|---|---|---|---|
| `non-deductible-health` | Health insurance premiums — always review | Not Schedule C — Schedule 1, line 17 | `off-form-health` | **nothing** | Self-employed health premiums are an adjustment to income, not a Schedule C expense. Recorded so the figure is not lost, kept off the expense lines. |
| `non-deductible-owner-draw` | Owner draw | Not deductible | `off-form-draw` | **nothing** | Money taken out by the owner. Not a business expense at all. |
| `non-deductible-personal` | Personal spend — always review | Not deductible | `off-form-personal` | **nothing** | Personal purchases that reached a business account. Recorded and excluded, so the reviewer can see what was set aside and why. |
| `non-deductible-income-tax` | Income tax paid | Not deductible on Schedule C | `off-form-tax` | **nothing** | Federal or state income tax and estimated payments. Tracked against the 1040-ES worksheet, never an expense. |
| `uncategorised` | Uncategorised — always review | Not on any line until categorised | `off-form-uncategorised` | **nothing** | The document was read but nothing here describes it. It stays off every form line and on the open-items list until a person places it. |

"always review" marks `alwaysReview: true`.

## The seven that always go to a human

These are flagged whatever the model's confidence, and the flag carries the
reason below verbatim. `category-needs-judgement` is the exception kind they
raise.

| id | Why it is not the assistant's call |
|---|---|
| `expense-vehicle` | Mileage and actual-cost methods give different numbers and cannot be mixed year to year. A person picks the method. |
| `expense-depreciation` | Whether to capitalise, expense under de minimis, or elect section 179 is a decision with multi-year consequences. Not the assistant's to make. |
| `expense-utilities` | Phone and internet lines are commonly part personal. The business-use fraction is the reviewer's to set. |
| `expense-home-office` | The claim depends on exclusive-use square footage that no document states. A person computes it on Form 8829. |
| `non-deductible-health` | The deduction is limited by net profit and other coverage. It belongs to whoever prepares the 1040, not to this schedule. |
| `non-deductible-personal` | Calling a purchase personal removes a deduction. It is stated as a possibility for a human to confirm, never applied silently. |
| `uncategorised` | An uncategorised document is an unanswered question, not a zero. Guessing a line to make the draft look complete is the failure this category exists to prevent. |

Reading that table as a list of things to be careful about misses the point.
They are not harder questions; they are questions belonging to somebody else. A
confident answer to one of them is still not an answer you may give.

## Where the fractions bite

| Category | Recorded | On the line | Why |
|---|---|---|---|
| `expense-meals` | The receipt total | Half of it | The statutory limit. Not a discrepancy in the receipts, and the draft says so on the line. |
| `expense-depreciation` | The full purchase | Nothing | `kind: "asset"`. The deductible figure comes from Form 4562 or a section 179 election, both a person's decision. |
| `expense-home-office` | The household costs apportioned to the workspace | Nothing | The chart calls it a full-fraction expense because the *category* is deductible. `lineFraction()` in `forms.ts` overrides it to zero: the allowable claim is computed on Form 8829 from an exclusive-use square footage no receipt states. |
| Every `non-deductible` | The amount | Nothing | Recorded so the money is not lost from the picture, kept off the expense lines. |

The pattern is the same in each: the figure is **recorded and visible**, and it
does not reach a line this app cannot justify. Nothing is dropped to make a
form balance, and nothing is carried to a line on a number the app invented.

## Keywords are hints, not rules

Each category carries a `keywords` list — `figma`, `wework`, `stripe fee`,
`toner`. They are hints in the classifier's prompt and nothing more. There is no
rule engine here: a document matching a keyword is not thereby categorised, and
a document matching none is not thereby uncategorisable.

Two traps the keywords deliberately do not resolve:

- **`laptop`, `macbook`, `monitor` sit under `expense-depreciation`**, not under
  office expense. A computer receipt is a capitalisation question wearing a
  receipt's clothes.
- **`licence fee` sits under `expense-taxes-licenses`** and `subscription sold`
  under `income-product`. The same word points opposite ways depending on which
  side of the business it is on.

## `uncategorised` is an answer

When nothing on the chart describes a document, it goes in `uncategorised` and
stays off every form line until a person places it. It carries `alwaysReview`.

An uncategorised document is an unanswered question, not a zero. Guessing a line
to make the draft look complete is the exact failure this category exists to
prevent, and `FormDraft.unmappedCategoryIds` is where the money in it is
reported, so a balanced-looking form cannot hide it.

## What the totals exclude, and why

`categoryTotals()` in `src/lib/classify.ts` counts a document into a category's
`docCount` but leaves it out of `recorded` when:

- **the currency is not the period's** — flagged as `currency-mismatch`, never
  converted, because no rate is printed on the document and a rate you chose is
  a figure nobody can check; or
- **there is no readable total** — an unreadable scan is a gap, not a payment of
  nothing.

So a category can show three documents and two documents' worth of money. That
is not an arithmetic error; it is the app refusing to invent the third figure.
Say which documents were set aside whenever you quote a total.
