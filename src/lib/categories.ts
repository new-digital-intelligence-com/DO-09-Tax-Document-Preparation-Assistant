import type { TaxCategory } from "./types";

/**
 * The firm's chart of tax categories.
 *
 * One file, because it is the contract three things share: the classifier
 * prompt is built from it, the form mapper rolls totals up by its `lineKey`,
 * and the skill's `references/categories.md` is generated from it. A category
 * added here reaches all three; a category described in a prompt reaches one.
 *
 * The jurisdiction is US federal, sole proprietor / single-member LLC, so the
 * lines are Schedule C (Form 1040). Swapping jurisdictions is a swap of this
 * file plus `forms.ts` — nothing else knows what a line number means.
 *
 * Two fields do the work that a flat list of names cannot:
 *
 *   `deductiblePct` — meals reach the return at 50%. A draft that puts the
 *   receipt total on the line is wrong while every document behind it is
 *   right, which is the hardest kind of error to spot in review.
 *
 *   `alwaysReview` — some categories are a judgement call by their nature. A
 *   laptop is not an expense, it is a depreciation question; a phone bill is
 *   part personal; health insurance is not on this form at all. The model does
 *   not decide those, it routes them.
 */
export const CATEGORIES: TaxCategory[] = [
  /* ── Income ─────────────────────────────────────────────────────────── */
  {
    id: "income-services",
    name: "Service revenue",
    kind: "income",
    formLine: "Schedule C, line 1",
    lineKey: "sc-1",
    description:
      "Fees invoiced to clients for services performed. The ordinary revenue line for a consultancy.",
    keywords: ["invoice", "professional services", "consulting", "retainer", "design", "development"],
  },
  {
    id: "income-product",
    name: "Product sales",
    kind: "income",
    formLine: "Schedule C, line 1",
    lineKey: "sc-1",
    description: "Sales of goods or licences, as distinct from time billed.",
    keywords: ["licence", "license", "subscription sold", "product", "units"],
  },
  {
    id: "income-refunds",
    name: "Returns, credits and allowances",
    kind: "income",
    formLine: "Schedule C, line 2",
    lineKey: "sc-2",
    description:
      "Credit notes and refunds issued to clients. Recorded positive here and subtracted from gross receipts on the form.",
    keywords: ["credit note", "refund", "allowance", "rebate to client"],
  },
  {
    id: "income-other",
    name: "Other business income",
    kind: "income",
    formLine: "Schedule C, line 6",
    lineKey: "sc-6",
    description:
      "Interest on business accounts, recoveries, and anything received in the course of business that is not a sale.",
    keywords: ["interest received", "recovery", "grant", "other income"],
  },

  /* ── Cost of goods sold ─────────────────────────────────────────────── */
  {
    id: "cogs-purchases",
    name: "Purchases for resale",
    kind: "cogs",
    formLine: "Schedule C, line 36",
    lineKey: "sc-36",
    description: "Goods bought to resell, and materials that go into what is sold.",
    keywords: ["wholesale", "for resale", "stock", "inventory"],
  },
  {
    id: "cogs-materials",
    name: "Materials and supplies (COGS)",
    kind: "cogs",
    formLine: "Schedule C, line 38",
    lineKey: "sc-38",
    description:
      "Materials consumed producing what is sold. Distinct from office supplies, which are an operating expense.",
    keywords: ["materials", "components", "production supplies"],
  },

  /* ── Operating expenses ─────────────────────────────────────────────── */
  {
    id: "expense-advertising",
    name: "Advertising and marketing",
    kind: "expense",
    formLine: "Schedule C, line 8",
    lineKey: "sc-8",
    description: "Paid advertising, sponsorships, marketing tools and campaign spend.",
    keywords: ["ads", "advertising", "google ads", "meta ads", "sponsorship", "marketing", "seo"],
  },
  {
    id: "expense-vehicle",
    name: "Car and truck expenses",
    kind: "expense",
    formLine: "Schedule C, line 9",
    lineKey: "sc-9",
    description:
      "Business mileage or actual vehicle costs. A mileage log is support, not a receipt — the rate is applied at form time.",
    keywords: ["mileage", "fuel", "parking", "toll", "vehicle", "car rental"],
    alwaysReview: true,
    reviewReason:
      "Mileage and actual-cost methods give different numbers and cannot be mixed year to year. A person picks the method.",
  },
  {
    id: "expense-commissions",
    name: "Commissions and fees",
    kind: "expense",
    formLine: "Schedule C, line 10",
    lineKey: "sc-10",
    description: "Referral commissions, agency fees, and payment-processor fees charged on revenue.",
    keywords: ["commission", "referral fee", "processing fee", "stripe fee", "paypal fee"],
  },
  {
    id: "expense-contract-labor",
    name: "Contract labour",
    kind: "expense",
    formLine: "Schedule C, line 11",
    lineKey: "sc-11",
    description:
      "Payments to non-employee contractors and freelancers. Feeds the 1099-NEC summary; the annual threshold is a setting.",
    keywords: ["contractor", "freelance", "subcontractor", "1099", "independent contractor"],
  },
  {
    id: "expense-depreciation",
    name: "Depreciation and section 179",
    kind: "asset",
    formLine: "Schedule C, line 13",
    lineKey: "sc-13",
    description:
      "Durable equipment above the capitalisation threshold. Capitalised and depreciated, never expensed in full without an election.",
    keywords: ["laptop", "macbook", "computer", "monitor", "camera", "furniture", "equipment"],
    alwaysReview: true,
    reviewReason:
      "Whether to capitalise, expense under de minimis, or elect section 179 is a decision with multi-year consequences. Not the assistant's to make.",
  },
  {
    id: "expense-insurance",
    name: "Insurance (other than health)",
    kind: "expense",
    formLine: "Schedule C, line 15",
    lineKey: "sc-15",
    description:
      "Business liability, professional indemnity, contents and cyber cover. Health premiums are not on this line.",
    keywords: ["liability insurance", "professional indemnity", "business insurance", "e&o", "cyber cover"],
  },
  {
    id: "expense-interest",
    name: "Interest (business loans and cards)",
    kind: "expense",
    formLine: "Schedule C, line 16b",
    lineKey: "sc-16b",
    description: "Interest on business borrowing and business credit cards.",
    keywords: ["interest charge", "loan interest", "finance charge"],
  },
  {
    id: "expense-professional",
    name: "Legal and professional services",
    kind: "expense",
    formLine: "Schedule C, line 17",
    lineKey: "sc-17",
    description: "Solicitors, accountants, bookkeepers, company formation and filing agents.",
    keywords: ["legal", "attorney", "solicitor", "accountant", "bookkeeping", "cpa", "registered agent"],
  },
  {
    id: "expense-office",
    name: "Office expense",
    kind: "expense",
    formLine: "Schedule C, line 18",
    lineKey: "sc-18",
    description:
      "Software subscriptions, cloud hosting, domains, postage and general office running costs.",
    keywords: [
      "software",
      "saas",
      "subscription",
      "hosting",
      "cloud",
      "aws",
      "google workspace",
      "figma",
      "adobe",
      "domain",
      "postage",
    ],
  },
  {
    id: "expense-rent-equipment",
    name: "Rent or lease — vehicles and equipment",
    kind: "expense",
    formLine: "Schedule C, line 20a",
    lineKey: "sc-20a",
    description: "Leased machinery, equipment and vehicles.",
    keywords: ["equipment lease", "machine rental", "vehicle lease"],
  },
  {
    id: "expense-rent-property",
    name: "Rent or lease — business property",
    kind: "expense",
    formLine: "Schedule C, line 20b",
    lineKey: "sc-20b",
    description: "Office rent, coworking desks and storage.",
    keywords: ["rent", "coworking", "wework", "office space", "storage unit", "desk"],
  },
  {
    id: "expense-repairs",
    name: "Repairs and maintenance",
    kind: "expense",
    formLine: "Schedule C, line 21",
    lineKey: "sc-21",
    description: "Keeping equipment and premises working. Improvements are capitalised instead.",
    keywords: ["repair", "maintenance", "service call", "fix"],
  },
  {
    id: "expense-supplies",
    name: "Supplies",
    kind: "expense",
    formLine: "Schedule C, line 22",
    lineKey: "sc-22",
    description: "Consumables used in the business — stationery, printer supplies, small tools.",
    keywords: ["stationery", "paper", "toner", "office supplies", "staples"],
  },
  {
    id: "expense-taxes-licenses",
    name: "Taxes and licences",
    kind: "expense",
    formLine: "Schedule C, line 23",
    lineKey: "sc-23",
    description:
      "Business licences, registration and franchise fees, and employer payroll taxes. Income tax is not deductible here.",
    keywords: ["license fee", "licence fee", "registration", "franchise tax", "permit", "state fee"],
  },
  {
    id: "expense-travel",
    name: "Travel",
    kind: "expense",
    formLine: "Schedule C, line 24a",
    lineKey: "sc-24a",
    description: "Business travel away from the tax home — flights, hotels, ground transport.",
    keywords: ["flight", "airline", "hotel", "lodging", "train", "taxi", "rideshare", "airbnb"],
  },
  {
    id: "expense-meals",
    name: "Business meals",
    kind: "expense",
    formLine: "Schedule C, line 24b",
    lineKey: "sc-24b",
    description:
      "Meals with a business purpose. Reaches the return at 50% of the recorded amount; the draft shows both figures.",
    keywords: ["restaurant", "meal", "lunch", "dinner", "coffee", "catering", "client dinner"],
    deductiblePct: 0.5,
  },
  {
    id: "expense-utilities",
    name: "Utilities",
    kind: "expense",
    formLine: "Schedule C, line 25",
    lineKey: "sc-25",
    description:
      "Business phone, internet and power. A line shared with a household is apportioned, not claimed in full.",
    keywords: ["phone", "mobile", "internet", "broadband", "electricity", "utility"],
    alwaysReview: true,
    reviewReason:
      "Phone and internet lines are commonly part personal. The business-use fraction is the reviewer's to set.",
  },
  {
    id: "expense-wages",
    name: "Wages",
    kind: "expense",
    formLine: "Schedule C, line 26",
    lineKey: "sc-26",
    description: "Payroll for employees, excluding amounts paid to the owner.",
    keywords: ["payroll", "salary", "wages", "employee pay"],
  },
  {
    id: "expense-training",
    name: "Training and professional development",
    kind: "expense",
    formLine: "Schedule C, line 27a",
    lineKey: "sc-27a",
    description: "Courses, conferences, books and memberships that maintain existing skills.",
    keywords: ["course", "conference", "training", "membership", "certification", "workshop"],
  },
  {
    id: "expense-bank-fees",
    name: "Bank and merchant fees",
    kind: "expense",
    formLine: "Schedule C, line 27a",
    lineKey: "sc-27a",
    description: "Account charges, wire fees and card scheme costs not netted off revenue.",
    keywords: ["bank fee", "wire fee", "account charge", "fx fee", "monthly maintenance"],
  },
  {
    id: "expense-other",
    name: "Other business expenses",
    kind: "expense",
    formLine: "Schedule C, line 27a",
    lineKey: "sc-27a",
    description: "Ordinary and necessary business costs no other line describes. Itemised on the draft.",
    keywords: ["misc", "other", "sundry"],
  },

  /* ── Home office ────────────────────────────────────────────────────── */
  {
    id: "expense-home-office",
    name: "Home office",
    kind: "expense",
    formLine: "Schedule C, line 30 (via Form 8829)",
    lineKey: "sc-30",
    description:
      "Household costs apportioned to a dedicated work space. Computed on Form 8829, not claimed from a receipt.",
    keywords: ["home office", "rent portion", "household utility", "8829"],
    alwaysReview: true,
    reviewReason:
      "The claim depends on exclusive-use square footage that no document states. A person computes it on Form 8829.",
  },

  /* ── Recorded, but not deductible here ──────────────────────────────── */
  {
    id: "non-deductible-health",
    name: "Health insurance premiums",
    kind: "non-deductible",
    formLine: "Not Schedule C — Schedule 1, line 17",
    lineKey: "off-form-health",
    description:
      "Self-employed health premiums are an adjustment to income, not a Schedule C expense. Recorded so the figure is not lost, kept off the expense lines.",
    keywords: ["health insurance", "medical premium", "dental plan", "aca"],
    alwaysReview: true,
    reviewReason:
      "The deduction is limited by net profit and other coverage. It belongs to whoever prepares the 1040, not to this schedule.",
  },
  {
    id: "non-deductible-owner-draw",
    name: "Owner draw",
    kind: "non-deductible",
    formLine: "Not deductible",
    lineKey: "off-form-draw",
    description: "Money taken out by the owner. Not a business expense at all.",
    keywords: ["owner draw", "distribution", "transfer to personal", "drawings"],
  },
  {
    id: "non-deductible-personal",
    name: "Personal spend",
    kind: "non-deductible",
    formLine: "Not deductible",
    lineKey: "off-form-personal",
    description:
      "Personal purchases that reached a business account. Recorded and excluded, so the reviewer can see what was set aside and why.",
    keywords: ["groceries", "personal", "household", "clothing", "gift"],
    alwaysReview: true,
    reviewReason:
      "Calling a purchase personal removes a deduction. It is stated as a possibility for a human to confirm, never applied silently.",
  },
  {
    id: "non-deductible-income-tax",
    name: "Income tax paid",
    kind: "non-deductible",
    formLine: "Not deductible on Schedule C",
    lineKey: "off-form-tax",
    description:
      "Federal or state income tax and estimated payments. Tracked against the 1040-ES worksheet, never an expense.",
    keywords: ["estimated tax", "1040-es", "irs payment", "state income tax"],
  },

  /* ── The escape hatch ───────────────────────────────────────────────── */
  {
    id: "uncategorised",
    name: "Uncategorised",
    kind: "non-deductible",
    formLine: "Not on any line until categorised",
    lineKey: "off-form-uncategorised",
    description:
      "The document was read but nothing here describes it. It stays off every form line and on the open-items list until a person places it.",
    keywords: [],
    alwaysReview: true,
    reviewReason:
      "An uncategorised document is an unanswered question, not a zero. Guessing a line to make the draft look complete is the failure this category exists to prevent.",
  },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: string): TaxCategory | undefined {
  return BY_ID.get(id);
}

export function categoryName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

/** Fraction of a recorded amount that reaches the form line. */
export function deductibleFraction(id: string): number {
  const category = BY_ID.get(id);
  if (!category) return 0;
  if (category.kind === "non-deductible" || category.kind === "asset") return 0;
  return category.deductiblePct ?? 1;
}

/** The chart as the classifier sees it: id, name, what belongs, and the traps. */
export function categoryPrompt(): string {
  return CATEGORIES.map((c) => {
    const bits = [`${c.id} — ${c.name} [${c.kind}] (${c.formLine})`, `  ${c.description}`];
    if (c.deductiblePct !== undefined) {
      bits.push(`  Only ${Math.round(c.deductiblePct * 100)}% of the amount reaches the form line.`);
    }
    if (c.alwaysReview) bits.push(`  ALWAYS route to a human: ${c.reviewReason}`);
    if (c.keywords.length) bits.push(`  Typical: ${c.keywords.join(", ")}`);
    return bits.join("\n");
  }).join("\n\n");
}
