#!/usr/bin/env node
/**
 * Build the fixture corpus: 39 PDFs, a ledger CSV, and the manifest that says
 * what each of them is supposed to be.
 *
 *   node scripts/generate-fixtures.mjs        # write fixtures/
 *
 * The corpus is this build's test suite. Every `ExceptionKind` in
 * `src/lib/types.ts` has at least one document or ledger row engineered to
 * raise it, and `fixtures/manifest.json` records the expected finding beside
 * each file so `scripts/smoke.mjs` can check the pipeline against a written
 * answer rather than against whatever it happened to produce.
 *
 * Two rules shaped every document below.
 *
 *   **The defects are real defects, not markers.** The Northgate invoice does
 *   not say "total mismatch"; it prints 900.00 + 72.00 = 927.00, a digit
 *   transposition a tired person makes and a reviewer misses. A fixture that
 *   announces its own fault tests the reader, not the pipeline.
 *
 *   **The `truth` block is what a correct extraction returns, not an
 *   assertion.** A model that reads `1,842.19` as `1842.19` has not made a
 *   mistake. The smoke script compares numerically and case-insensitively and
 *   reports drift; nothing here fails a build because a vendor name came back
 *   as "AWS" instead of "Amazon Web Services, Inc."
 *
 * The generator writes no `.data/` state. Seeding is `scripts/seed.mjs`, and
 * keeping them apart means the corpus can be regenerated and diffed without
 * touching a register that may already have a reviewer's notes in it.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pdf } from "../src/lib/pdf-lite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures");
const DOCS_OUT = path.join(OUT, "documents");

/* ────────────────────────────────────────────────────────────────────────────
 * The entity and the period
 * ────────────────────────────────────────────────────────────────────────── */

const ENTITY = {
  name: "Northwind Studio LLC",
  street: "1180 Kettle Row, Suite 4",
  city: "Portland, OR 97209",
  ein: "87-4419203",
  email: "accounts@northwind.studio",
  phone: "(503) 555-0142",
};

const PERIOD = {
  id: "period_2025_q1",
  label: "2025 Q1",
  start: "2025-01-01",
  end: "2025-03-31",
  currency: "USD",
};

/* ────────────────────────────────────────────────────────────────────────────
 * Ink
 * ────────────────────────────────────────────────────────────────────────── */

const INK = [0.09, 0.1, 0.12];
const SOFT = [0.42, 0.45, 0.5];
const FAINT = [0.62, 0.65, 0.7];
const RULE = [0.8, 0.82, 0.85];
const TINT = [0.955, 0.96, 0.968];
const WHITE = [1, 1, 1];

const M = 54; // left margin
const R = 558; // right edge
const W = 612;

/* ────────────────────────────────────────────────────────────────────────────
 * Formatting
 * ────────────────────────────────────────────────────────────────────────── */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

/** `2025-01-08` → `January 8, 2025`. String maths only: no Date, no timezone. */
function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${SHORT[m - 1]} ${y}`;
}

function slashDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

/** `2025-03-05` → `05.03.2025`, the way the Hetzner invoice prints it. */
function germanDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}

function group(value) {
  return Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const usd = (value) => `${value < 0 ? "-" : ""}$${group(value)}`;
const eur = (value) => `${group(value)} €`;
const plain = (value) => `${value < 0 ? "-" : ""}${group(value)}`;

/* ────────────────────────────────────────────────────────────────────────────
 * Shared page furniture
 * ────────────────────────────────────────────────────────────────────────── */

/** A label/value pair stacked in a right-hand meta column. */
function metaRows(doc, x, y, rows, { valueRight = R, step = 17 } = {}) {
  rows.forEach(([label, value], i) => {
    const line = y + i * step;
    doc.text(x, line, label, { size: 7.4, color: SOFT, charSpace: 0.8 });
    doc.textRight(valueRight, line, value, { font: "Helvetica-Bold", size: 9.2, color: INK });
  });
  return y + rows.length * step;
}

/** Column headings over a hairline. Every table in the corpus opens with one. */
function tableHead(doc, y, columns, { color = SOFT } = {}) {
  for (const [x, label, align] of columns) {
    if (align === "right") doc.textRight(x, y, label, { size: 7.4, color, charSpace: 0.7 });
    else doc.text(x, y, label, { size: 7.4, color, charSpace: 0.7 });
  }
  doc.line(M, y + 6, R, y + 6, { color: RULE, lineWidth: 0.8 });
  return y + 22;
}

/** The boxed "amount due" every invoice ends on. */
function totalBox(doc, y, label, amount, { accent = INK, width = 232 } = {}) {
  const x = R - width;
  doc.rect(x, y, width, 34, { fill: TINT });
  doc.rect(x, y, 3.2, 34, { fill: accent });
  doc.text(x + 14, y + 21, label, { font: "Helvetica-Bold", size: 9, color: SOFT, charSpace: 0.6 });
  doc.textRight(R - 14, y + 22, amount, { font: "Helvetica-Bold", size: 13.5, color: INK });
  return y + 34;
}

function footNote(doc, y, lines, { size = 7.4 } = {}) {
  doc.line(M, y, R, y, { color: RULE, lineWidth: 0.5 });
  lines.forEach((line, i) => {
    doc.text(M, y + 14 + i * 10.5, line, { size, color: FAINT });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 1 — invoices Northwind issues
 * ────────────────────────────────────────────────────────────────────────── */

const NW_ACCENT = [0.05, 0.24, 0.28];

function northwindInvoice({ title = "INVOICE", accent = NW_ACCENT, ...cfg }) {
  const doc = new Pdf();
  doc.page();

  doc.rect(0, 0, W, 104, { fill: accent });
  doc.text(M, 44, "NORTHWIND STUDIO", {
    font: "Helvetica-Bold", size: 17, color: WHITE, charSpace: 1.6,
  });
  doc.text(M, 62, "Design and development, Portland OR", {
    size: 8.4, color: [0.74, 0.85, 0.86], charSpace: 0.9,
  });
  doc.text(M, 82, `${ENTITY.street} · ${ENTITY.city} · EIN ${ENTITY.ein}`, {
    size: 7.4, color: [0.62, 0.78, 0.79],
  });
  doc.textRight(R, 48, title, { font: "Helvetica-Bold", size: 21, color: WHITE, charSpace: 1.4 });
  doc.textRight(R, 68, cfg.number, { font: "Courier", size: 10.5, color: [0.74, 0.85, 0.86] });

  doc.text(M, 148, "BILL TO", { size: 7.4, color: SOFT, charSpace: 0.9 });
  doc.text(M, 166, cfg.client, { font: "Helvetica-Bold", size: 12, color: INK });
  cfg.clientAddress.forEach((line, i) => {
    doc.text(M, 183 + i * 12.5, line, { size: 9, color: SOFT });
  });

  metaRows(doc, 372, 148, [
    ["ISSUE DATE", longDate(cfg.issueDate)],
    ["PAYMENT DUE", longDate(cfg.dueDate)],
    ["TERMS", cfg.terms ?? "Net 15"],
    ["PROJECT", cfg.project],
  ]);

  let y = tableHead(doc, 248, [
    [M, "DESCRIPTION"],
    [432, "QTY", "right"],
    [492, "RATE", "right"],
    [R, "AMOUNT", "right"],
  ]);

  for (const item of cfg.lines) {
    doc.text(M, y, item.desc, { size: 9.6, color: INK });
    if (item.note) doc.text(M, y + 12, item.note, { size: 8, color: FAINT });
    doc.textRight(432, y, item.qty, { size: 9.6, color: SOFT });
    doc.textRight(492, y, item.rate, { size: 9.6, color: SOFT });
    doc.textRight(R, y, usd(item.amount), { font: "Helvetica-Bold", size: 9.6, color: INK });
    y += item.note ? 32 : 22;
  }

  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  doc.textRight(492, y, "Subtotal", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.subtotal), { size: 9.2, color: INK });
  y += 16;
  doc.textRight(492, y, cfg.taxLabel ?? "Sales tax (services, OR)", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.tax ?? 0), { size: 9.2, color: INK });
  y += 18;

  totalBox(doc, y, cfg.totalLabel ?? "TOTAL DUE (USD)", usd(cfg.total), { accent, width: 232 });

  footNote(doc, 668, [
    `Remit to ${ENTITY.name} · Cascadia Commerce Bank · Routing 123000848 · Account ••••4471`,
    `Questions: ${ENTITY.email} · ${ENTITY.phone}. Late balances accrue 1.5% monthly after 30 days.`,
    ...(cfg.footer ?? []),
  ]);
  return doc;
}

function northwindCreditNote(cfg) {
  const doc = northwindInvoice({
    ...cfg,
    title: "CREDIT NOTE",
    accent: [0.42, 0.11, 0.11],
    totalLabel: "CREDIT APPLIED (USD)",
  });
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 2 — the AWS invoice
 * ────────────────────────────────────────────────────────────────────────── */

function awsInvoice(cfg) {
  const doc = new Pdf();
  doc.page();

  doc.text(M, 60, "Amazon Web Services, Inc.", { font: "Helvetica-Bold", size: 15, color: INK });
  doc.text(M, 76, "410 Terry Avenue North, Seattle, WA 98109-5210", { size: 8.4, color: SOFT });
  doc.text(M, 88, "aws.amazon.com/contact-us", { size: 8.4, color: SOFT });
  doc.textRight(R, 62, "Invoice", { font: "Helvetica-Bold", size: 22, color: [0.93, 0.55, 0.06] });
  doc.line(M, 104, R, 104, { color: [0.93, 0.55, 0.06], lineWidth: 2 });

  doc.rect(M, 124, R - M, 96, { fill: TINT });
  const cells = [
    ["Invoice Summary", ""],
    ["Invoice Number", cfg.number],
    ["Invoice Date", longDate(cfg.issueDate)],
    ["Account Number", cfg.account],
    ["Billing Period", `${longDate(cfg.periodStart)} - ${longDate(cfg.periodEnd)}`],
  ];
  cells.forEach(([label, value], i) => {
    if (i === 0) {
      doc.text(M + 16, 148, label, { font: "Helvetica-Bold", size: 10.5, color: INK });
      return;
    }
    const line = 148 + i * 16;
    doc.text(M + 16, line, label, { size: 8.8, color: SOFT });
    doc.text(M + 190, line, value, { font: "Courier", size: 8.8, color: INK });
  });
  doc.textRight(R - 16, 160, "TOTAL AMOUNT DUE", { size: 8, color: SOFT, charSpace: 0.7 });
  doc.textRight(R - 16, 186, usd(cfg.total), { font: "Helvetica-Bold", size: 19, color: INK });
  doc.textRight(R - 16, 202, "Charged to card ending 4471", { size: 7.6, color: FAINT });

  doc.text(M, 258, "Charges by service", { font: "Helvetica-Bold", size: 11, color: INK });
  let y = tableHead(doc, 284, [
    [M, "SERVICE"],
    [286, "REGION"],
    [388, "USAGE"],
    [R, "AMOUNT", "right"],
  ]);
  for (const row of cfg.services) {
    doc.text(M, y, row.service, { size: 9.2, color: INK });
    doc.text(286, y, row.region, { size: 9.2, color: SOFT });
    doc.text(388, y, row.usage, { size: 8.2, color: SOFT });
    doc.textRight(R, y, usd(row.amount), { size: 9.2, color: INK });
    y += 19;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 12;
  doc.text(392, y, "Charges", { size: 9, color: SOFT });
  doc.textRight(R, y, usd(cfg.subtotal), { size: 9, color: INK });
  y += 15;
  doc.text(392, y, "Tax", { size: 9, color: SOFT });
  doc.textRight(R, y, usd(cfg.tax), { size: 9, color: INK });
  y += 18;
  totalBox(doc, y, "TOTAL FOR THIS INVOICE", usd(cfg.total), {
    accent: [0.93, 0.55, 0.06], width: 250,
  });

  footNote(doc, 690, [
    "This invoice is for the AWS account named above. Amounts are in USD.",
    "Service charges are metered and may differ month to month. Tax is calculated at the billing address on file.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 3 — the software-subscription receipt
 * ────────────────────────────────────────────────────────────────────────── */

function saasReceipt(cfg) {
  const doc = new Pdf();
  doc.page();

  doc.rect(0, 0, W, 8, { fill: cfg.accent });
  doc.text(M, 68, cfg.vendor, { font: "Helvetica-Bold", size: 16, color: INK });
  doc.text(M, 84, cfg.vendorAddress, { size: 8.4, color: SOFT });
  doc.textRight(R, 62, "RECEIPT", { size: 9, color: SOFT, charSpace: 1.6 });
  doc.textRight(R, 84, usd(cfg.total), { font: "Helvetica-Bold", size: 22, color: INK });
  doc.textRight(R, 98, `Paid ${longDate(cfg.issueDate)}`, { size: 8.2, color: FAINT });

  doc.line(M, 122, R, 122, { color: RULE, lineWidth: 0.8 });

  metaRows(doc, M, 152, [
    ["RECEIPT NUMBER", cfg.number],
    ["BILLED TO", ENTITY.name],
    ["BILLING EMAIL", ENTITY.email],
    ["PAYMENT METHOD", cfg.card ?? "Visa ending 4471"],
  ], { valueRight: 300 });

  metaRows(doc, 330, 152, [
    ["PLAN", cfg.plan],
    ["BILLING CYCLE", cfg.cycle],
    ["SERVICE PERIOD", `${shortDate(cfg.periodStart)} – ${shortDate(cfg.periodEnd)}`],
    ["STATUS", "Paid in full"],
  ]);

  let y = tableHead(doc, 258, [
    [M, "ITEM"],
    [400, "QTY", "right"],
    [470, "UNIT", "right"],
    [R, "AMOUNT", "right"],
  ]);
  for (const item of cfg.lines) {
    doc.text(M, y, item.desc, { size: 9.6, color: INK });
    doc.textRight(400, y, item.qty, { size: 9.6, color: SOFT });
    doc.textRight(470, y, item.unit, { size: 9.6, color: SOFT });
    doc.textRight(R, y, usd(item.amount), { size: 9.6, color: INK });
    y += 21;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  doc.textRight(492, y, "Subtotal", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.subtotal), { size: 9.2, color: INK });
  y += 16;
  doc.textRight(492, y, cfg.taxLabel ?? "Tax", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.tax), { size: 9.2, color: INK });
  y += 18;
  totalBox(doc, y, "TOTAL PAID (USD)", usd(cfg.total), { accent: cfg.accent, width: 220 });

  footNote(doc, 690, cfg.footer ?? [
    `${cfg.vendor} — this receipt is issued for your records. No further payment is due.`,
    "Subscriptions renew automatically until cancelled from the organisation's billing settings.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 4 — the ordinary supplier invoice
 * ────────────────────────────────────────────────────────────────────────── */

function supplierInvoice(cfg) {
  const doc = new Pdf();
  doc.page();
  const accent = cfg.accent ?? [0.16, 0.2, 0.3];

  doc.text(M, 56, cfg.vendor, { font: "Helvetica-Bold", size: 16, color: accent });
  if (cfg.tagline) doc.text(M, 72, cfg.tagline, { size: 8.6, color: SOFT, charSpace: 0.6 });
  cfg.vendorAddress.forEach((line, i) => {
    doc.text(M, 92 + i * 11.5, line, { size: 8.4, color: SOFT });
  });
  doc.textRight(R, 58, cfg.title ?? "INVOICE", {
    font: "Helvetica-Bold", size: 18, color: INK, charSpace: 1.2,
  });
  doc.textRight(R, 76, cfg.number, { font: "Courier", size: 10, color: SOFT });
  doc.line(M, 138, R, 138, { color: accent, lineWidth: 1.6 });

  doc.text(M, 168, "INVOICE TO", { size: 7.4, color: SOFT, charSpace: 0.9 });
  doc.text(M, 186, ENTITY.name, { font: "Helvetica-Bold", size: 11, color: INK });
  doc.text(M, 202, ENTITY.street, { size: 9, color: SOFT });
  doc.text(M, 215, ENTITY.city, { size: 9, color: SOFT });

  metaRows(doc, 372, 168, [
    ["INVOICE DATE", longDate(cfg.issueDate)],
    ["DUE DATE", longDate(cfg.dueDate)],
    ["TERMS", cfg.terms ?? "Net 30"],
    ...(cfg.vendorTaxId ? [["VENDOR TAX ID", cfg.vendorTaxId]] : []),
    ...(cfg.reference ? [["REFERENCE", cfg.reference]] : []),
  ]);

  let y = tableHead(doc, 262, cfg.hours
    ? [[M, "SERVICE"], [388, "HOURS", "right"], [470, "RATE", "right"], [R, "AMOUNT", "right"]]
    : [[M, "DESCRIPTION"], [388, "QTY", "right"], [470, "UNIT PRICE", "right"], [R, "AMOUNT", "right"]]);

  for (const item of cfg.lines) {
    doc.text(M, y, item.desc, { size: 9.6, color: INK });
    if (item.note) doc.text(M, y + 12, item.note, { size: 8, color: FAINT });
    doc.textRight(388, y, item.qty, { size: 9.6, color: SOFT });
    doc.textRight(470, y, item.unit, { size: 9.6, color: SOFT });
    doc.textRight(R, y, usd(item.amount), { size: 9.6, color: INK });
    y += item.note ? 31 : 21;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  doc.textRight(486, y, "Subtotal", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.subtotal), { size: 9.2, color: INK });
  y += 16;
  doc.textRight(486, y, cfg.taxLabel ?? "Sales tax", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.tax), { size: 9.2, color: INK });
  y += 18;
  totalBox(doc, y, cfg.totalLabel ?? "BALANCE DUE (USD)", usd(cfg.total), { accent, width: 232 });

  if (cfg.body) {
    doc.text(M, y + 62, cfg.body, { size: 8.8, color: SOFT });
  }
  footNote(doc, 690, cfg.footer ?? [
    `Please quote ${cfg.number} with payment. Cheques payable to ${cfg.vendor}.`,
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 5 — the till-roll receipt
 * ────────────────────────────────────────────────────────────────────────── */

function tillReceipt(cfg) {
  const width = 288;
  const doc = new Pdf({ width, height: cfg.height ?? 612 });
  doc.page();
  const mid = width / 2;
  const left = 24;
  const right = width - 24;

  let y = 46;
  doc.textCentre(mid, y, cfg.store, { font: "Helvetica-Bold", size: 12.5, color: INK, charSpace: 1 });
  y += 15;
  for (const line of cfg.storeAddress) {
    doc.textCentre(mid, y, line, { font: "Courier", size: 7.6, color: SOFT });
    y += 10;
  }
  y += 6;
  doc.line(left, y, right, y, { color: RULE, lineWidth: 0.6 });
  y += 16;

  doc.text(left, y, `DATE ${slashDate(cfg.issueDate)}`, { font: "Courier", size: 7.8, color: SOFT });
  doc.textRight(right, y, cfg.time, { font: "Courier", size: 7.8, color: SOFT });
  y += 11;
  doc.text(left, y, `STORE ${cfg.storeNumber}`, { font: "Courier", size: 7.8, color: SOFT });
  doc.textRight(right, y, `TXN ${cfg.txn}`, { font: "Courier", size: 7.8, color: SOFT });
  y += 10;
  doc.line(left, y, right, y, { color: RULE, lineWidth: 0.6 });
  y += 16;

  for (const item of cfg.items) {
    doc.text(left, y, item.desc, { font: "Courier", size: 8.4, color: INK });
    doc.textRight(right, y, plain(item.amount), { font: "Courier", size: 8.4, color: INK });
    y += 11;
    if (item.note) {
      doc.text(left + 10, y, item.note, { font: "Courier", size: 7.2, color: FAINT });
      y += 10;
    }
  }

  y += 4;
  doc.line(left, y, right, y, { color: RULE, lineWidth: 0.6 });
  y += 15;
  for (const [label, value, bold] of cfg.totals) {
    doc.text(left, y, label, {
      font: bold ? "Helvetica-Bold" : "Courier", size: bold ? 10 : 8.4, color: INK,
    });
    doc.textRight(right, y, value, {
      font: bold ? "Helvetica-Bold" : "Courier", size: bold ? 10 : 8.4, color: INK,
    });
    y += bold ? 16 : 12;
  }

  y += 8;
  doc.line(left, y, right, y, { color: RULE, lineWidth: 0.6 });
  y += 15;
  for (const line of cfg.tail) {
    doc.textCentre(mid, y, line, { font: "Courier", size: 7.4, color: SOFT });
    y += 10;
  }

  // A barcode drawn as bars, not as glyphs — it is furniture, and nothing in
  // the pipeline should be able to read a figure out of it.
  const bars = cfg.txn.split("").map((ch) => (ch.charCodeAt(0) % 5) + 1);
  let bx = mid - (bars.length * 6) / 2;
  for (const bar of bars) {
    doc.rect(bx, y + 12, bar * 0.9, 26, { fill: [0.15, 0.15, 0.17] });
    bx += 6;
  }
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 6 — the Stripe payout report
 * ────────────────────────────────────────────────────────────────────────── */

function stripePayout(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = [0.39, 0.34, 0.86];

  doc.rect(0, 0, W, 120, { fill: [0.1, 0.11, 0.16] });
  doc.text(M, 48, "stripe", { font: "Helvetica-Bold", size: 19, color: WHITE, charSpace: 0.6 });
  doc.text(M, 70, "Payout report", { size: 10.5, color: [0.68, 0.7, 0.8], charSpace: 1.4 });
  doc.text(M, 94, `${ENTITY.name} · acct_1NwStudioPDX`, { size: 8.2, color: [0.55, 0.58, 0.7] });
  doc.textRight(R, 52, cfg.payoutId, { font: "Courier", size: 10, color: [0.68, 0.7, 0.8] });
  doc.textRight(R, 80, usd(cfg.net), { font: "Helvetica-Bold", size: 22, color: WHITE });
  doc.textRight(R, 96, `Paid out ${longDate(cfg.paidOn)} to ••••4471`, {
    size: 7.8, color: [0.55, 0.58, 0.7],
  });

  doc.text(M, 158, `Activity for ${cfg.periodLabel}`, { font: "Helvetica-Bold", size: 12, color: INK });
  doc.text(M, 174, "All amounts in USD. Fees are deducted before payout and are a business expense in their own right.", {
    size: 8, color: SOFT,
  });

  let y = tableHead(doc, 210, [
    [M, "SUMMARY"],
    [420, "COUNT", "right"],
    [R, "AMOUNT", "right"],
  ]);
  const summary = [
    ["Charges (gross volume)", String(cfg.chargeCount), cfg.gross],
    ["Refunds issued", "0", 0],
    ["Stripe processing fees", String(cfg.chargeCount), -cfg.fees],
    ["Adjustments", "0", 0],
  ];
  for (const [label, count, amount] of summary) {
    doc.text(M, y, label, { size: 9.6, color: INK });
    doc.textRight(420, y, count, { size: 9.6, color: SOFT });
    doc.textRight(R, y, usd(amount), { size: 9.6, color: INK });
    y += 21;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 16;
  doc.text(M, y, "Net paid out", { font: "Helvetica-Bold", size: 10.5, color: INK });
  doc.textRight(R, y, usd(cfg.net), { font: "Helvetica-Bold", size: 11.5, color: INK });
  y += 34;

  doc.text(M, y, "Charges in this payout", { font: "Helvetica-Bold", size: 11, color: INK });
  y = tableHead(doc, y + 26, [
    [M, "DATE"],
    [128, "CUSTOMER"],
    [320, "CHARGE ID"],
    [468, "FEE", "right"],
    [R, "GROSS", "right"],
  ]);
  for (const row of cfg.charges) {
    doc.text(M, y, shortDate(row.date), { size: 8.8, color: SOFT });
    doc.text(128, y, row.customer, { size: 8.8, color: INK });
    doc.text(320, y, row.chargeId, { font: "Courier", size: 8, color: FAINT });
    doc.textRight(468, y, usd(row.fee), { size: 8.8, color: SOFT });
    doc.textRight(R, y, usd(row.gross), { size: 8.8, color: INK });
    y += 18;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  doc.text(320, y, "Totals", { font: "Helvetica-Bold", size: 9, color: SOFT });
  doc.textRight(468, y, usd(cfg.fees), { font: "Helvetica-Bold", size: 9, color: INK });
  doc.textRight(R, y, usd(cfg.gross), { font: "Helvetica-Bold", size: 9, color: INK });

  y += 26;
  totalBox(doc, y, "NET DEPOSITED (USD)", usd(cfg.net), { accent: brand, width: 250 });

  footNote(doc, 700, [
    "Stripe Payments Company, 354 Oyster Point Boulevard, South San Francisco, CA 94080.",
    "This report is a statement of account activity, not an invoice. Gross volume is revenue; processing fees are an expense.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 7 — the airline e-ticket
 * ────────────────────────────────────────────────────────────────────────── */

function eTicket(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = [0.06, 0.16, 0.38];

  doc.rect(0, 0, W, 78, { fill: brand });
  doc.text(M, 34, "DELTA", { font: "Helvetica-Bold", size: 18, color: WHITE, charSpace: 3.2 });
  doc.text(M, 56, "ELECTRONIC TICKET RECEIPT", { size: 8.6, color: [0.72, 0.79, 0.9], charSpace: 1.6 });
  doc.textRight(R, 36, "CONFIRMATION", { size: 7.6, color: [0.72, 0.79, 0.9], charSpace: 1 });
  doc.textRight(R, 58, cfg.recordLocator, { font: "Helvetica-Bold", size: 17, color: WHITE, charSpace: 2 });

  metaRows(doc, M, 118, [
    ["PASSENGER", cfg.passenger],
    ["TICKET NUMBER", cfg.ticket],
    ["ISSUED", longDate(cfg.issueDate)],
    ["FREQUENT FLYER", cfg.skymiles],
  ], { valueRight: 300 });
  metaRows(doc, 372, 118, [
    ["FARE BASIS", cfg.fareBasis],
    ["FORM OF PAYMENT", "VI ••••4471"],
    ["ISSUING AGENT", "DELTA.COM"],
    ["TICKET STATUS", "USED / FLOWN"],
  ]);

  doc.text(M, 218, "Itinerary", { font: "Helvetica-Bold", size: 11.5, color: INK });
  let y = tableHead(doc, 244, [
    [M, "FLIGHT"],
    [122, "DATE"],
    [212, "FROM"],
    [318, "TO"],
    [424, "DEPART"],
    [R, "ARRIVE", "right"],
  ]);
  for (const leg of cfg.legs) {
    doc.text(M, y, leg.flight, { font: "Helvetica-Bold", size: 9.2, color: INK });
    doc.text(122, y, shortDate(leg.date), { size: 9.2, color: SOFT });
    doc.text(212, y, leg.from, { size: 9.2, color: INK });
    doc.text(318, y, leg.to, { size: 9.2, color: INK });
    doc.text(424, y, leg.depart, { size: 9.2, color: SOFT });
    doc.textRight(R, y, leg.arrive, { size: 9.2, color: SOFT });
    doc.text(M, y + 12, `${leg.cabin} · ${leg.aircraft} · seat ${leg.seat}`, { size: 7.8, color: FAINT });
    y += 32;
  }

  doc.text(M, y + 12, "Fare breakdown", { font: "Helvetica-Bold", size: 11.5, color: INK });
  y = tableHead(doc, y + 38, [[M, "CHARGE"], [R, "AMOUNT", "right"]]);
  for (const [label, amount] of cfg.fare) {
    doc.text(M, y, label, { size: 9.4, color: INK });
    doc.textRight(R, y, usd(amount), { size: 9.4, color: INK });
    y += 19;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 16;
  totalBox(doc, y, "TOTAL CHARGED (USD)", usd(cfg.total), { accent: brand, width: 250 });

  footNote(doc, 700, [
    "Delta Air Lines, Inc., PO Box 20706, Atlanta GA 30320. This receipt is proof of purchase.",
    "Fares include US federal excise tax, September 11th security fee and passenger facility charges where applicable.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 8 — the hotel folio
 * ────────────────────────────────────────────────────────────────────────── */

function hotelFolio(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = [0.14, 0.18, 0.24];

  doc.text(M, 54, cfg.hotel, { font: "Helvetica-Bold", size: 16, color: brand, charSpace: 1.4 });
  doc.text(M, 72, cfg.hotelAddress, { size: 8.4, color: SOFT });
  doc.text(M, 84, cfg.hotelPhone, { size: 8.4, color: SOFT });
  doc.textRight(R, 56, "GUEST FOLIO", { size: 10, color: SOFT, charSpace: 1.8 });
  doc.textRight(R, 76, `Folio ${cfg.folio}`, { font: "Courier", size: 9.6, color: INK });
  doc.line(M, 104, R, 104, { color: brand, lineWidth: 1.4 });

  metaRows(doc, M, 132, [
    ["GUEST", cfg.guest],
    ["COMPANY", ENTITY.name],
    ["ROOM", cfg.room],
    ["RATE PLAN", cfg.ratePlan],
  ], { valueRight: 300 });
  metaRows(doc, 372, 132, [
    ["ARRIVAL", longDate(cfg.arrival)],
    ["DEPARTURE", longDate(cfg.departure)],
    ["NIGHTS", String(cfg.nights)],
    ["CONFIRMATION", cfg.confirmation],
  ]);

  doc.text(M, 232, "Charges and credits", { font: "Helvetica-Bold", size: 11.5, color: INK });
  let y = tableHead(doc, 258, [
    [M, "DATE"],
    [128, "DESCRIPTION"],
    [430, "CHARGES", "right"],
    [R, "CREDITS", "right"],
  ]);
  for (const row of cfg.rows) {
    doc.text(M, y, shortDate(row.date), { size: 8.8, color: SOFT });
    doc.text(128, y, row.desc, { size: 9.2, color: INK });
    if (row.charge) doc.textRight(430, y, usd(row.charge), { size: 9.2, color: INK });
    if (row.credit) doc.textRight(R, y, usd(row.credit), { size: 9.2, color: INK });
    y += 18;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 16;
  doc.text(300, y, "Total charges", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(cfg.total), { size: 9.2, color: INK });
  y += 15;
  doc.text(300, y, "Total credits", { size: 9.2, color: SOFT });
  doc.textRight(R, y, usd(-cfg.paid), { size: 9.2, color: INK });
  y += 20;
  totalBox(doc, y, "BALANCE DUE (USD)", usd(cfg.total - cfg.paid), { accent: brand, width: 240 });

  doc.text(M, y + 60, `Settled to ${cfg.card} on departure. Thank you for staying with us.`, {
    size: 8.6, color: SOFT,
  });
  footNote(doc, 700, [
    "Room and tax charged nightly. State and city occupancy taxes are shown as separate lines above.",
    "Retain this folio for expense reporting; it is the only itemised record of the stay.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 9 — the insurance schedule
 * ────────────────────────────────────────────────────────────────────────── */

function insuranceSchedule(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = cfg.accent ?? [0.66, 0.12, 0.16];

  doc.rect(0, 0, W, 6, { fill: brand });
  doc.text(M, 62, cfg.insurer, { font: "Helvetica-Bold", size: 17, color: brand });
  doc.text(M, 80, cfg.insurerAddress, { size: 8.4, color: SOFT });
  doc.textRight(R, 60, cfg.title, { font: "Helvetica-Bold", size: 13, color: INK, charSpace: 0.8 });
  doc.textRight(R, 78, `Policy ${cfg.policy}`, { font: "Courier", size: 9.6, color: SOFT });
  doc.line(M, 104, R, 104, { color: RULE, lineWidth: 0.8 });

  metaRows(doc, M, 134, [
    ["NAMED INSURED", ENTITY.name],
    ["MAILING ADDRESS", ENTITY.street],
    ["", ENTITY.city],
  ], { valueRight: 320 });
  metaRows(doc, 372, 134, [
    ["STATEMENT DATE", longDate(cfg.issueDate)],
    ["POLICY PERIOD", `${slashDate(cfg.coverFrom)} – ${slashDate(cfg.coverTo)}`],
    ["AGENT", cfg.agent],
  ]);

  doc.text(M, 226, cfg.tableTitle ?? "Coverage", { font: "Helvetica-Bold", size: 11.5, color: INK });
  let y = tableHead(doc, 252, [
    [M, "COVERAGE"],
    [352, "LIMIT"],
    [R, "PREMIUM", "right"],
  ]);
  for (const row of cfg.coverages) {
    doc.text(M, y, row.name, { size: 9.4, color: INK });
    doc.text(352, y, row.limit, { size: 9.4, color: SOFT });
    doc.textRight(R, y, usd(row.premium), { size: 9.4, color: INK });
    y += 20;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 16;
  totalBox(doc, y, cfg.totalLabel ?? "TOTAL PREMIUM (USD)", usd(cfg.total), { accent: brand, width: 250 });

  doc.text(M, y + 62, cfg.body, { size: 8.8, color: SOFT });
  footNote(doc, 700, cfg.footer ?? [
    "This is a statement of premium, not a policy. Coverage is governed by the policy documents on file.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 10 — the wireless bill
 * ────────────────────────────────────────────────────────────────────────── */

function wirelessBill(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = [0.8, 0.09, 0.13];

  doc.text(M, 58, "verizon", { font: "Helvetica-Bold", size: 20, color: INK, charSpace: -0.3 });
  doc.rect(M + 78, 44, 16, 16, { fill: brand });
  doc.textRight(R, 50, "ACCOUNT SUMMARY", { size: 8.4, color: SOFT, charSpace: 1.2 });
  doc.textRight(R, 72, `Account ${cfg.account}`, { font: "Courier", size: 9.4, color: INK });
  doc.textRight(R, 88, `Invoice ${cfg.number}`, { font: "Courier", size: 9.4, color: SOFT });
  doc.line(M, 108, R, 108, { color: brand, lineWidth: 2 });

  doc.rect(M, 130, R - M, 74, { fill: TINT });
  doc.text(M + 16, 154, "Your bill at a glance", { font: "Helvetica-Bold", size: 11, color: INK });
  doc.text(M + 16, 172, `Billing period ${slashDate(cfg.periodStart)} to ${slashDate(cfg.periodEnd)}`, {
    size: 8.6, color: SOFT,
  });
  doc.text(M + 16, 186, `Due ${longDate(cfg.dueDate)} · autopay from card ending 4471`, {
    size: 8.6, color: SOFT,
  });
  doc.textRight(R - 16, 168, "TOTAL DUE", { size: 8, color: SOFT, charSpace: 0.8 });
  doc.textRight(R - 16, 192, usd(cfg.total), { font: "Helvetica-Bold", size: 20, color: INK });

  doc.text(M, 242, "Charges by line", { font: "Helvetica-Bold", size: 11.5, color: INK });
  let y = tableHead(doc, 268, [
    [M, "LINE"],
    [180, "USER"],
    [330, "PLAN"],
    [R, "AMOUNT", "right"],
  ]);
  for (const row of cfg.lines) {
    doc.text(M, y, row.number, { font: "Courier", size: 9, color: INK });
    doc.text(180, y, row.user, { size: 9.2, color: INK });
    doc.text(330, y, row.plan, { size: 9.2, color: SOFT });
    doc.textRight(R, y, usd(row.amount), { size: 9.2, color: INK });
    y += 20;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  for (const [label, amount] of cfg.extras) {
    doc.text(330, y, label, { size: 9, color: SOFT });
    doc.textRight(R, y, usd(amount), { size: 9, color: INK });
    y += 15;
  }
  y += 8;
  totalBox(doc, y, "TOTAL THIS MONTH (USD)", usd(cfg.total), { accent: brand, width: 250 });

  doc.text(M, y + 62, cfg.body, { size: 8.8, color: SOFT });
  footNote(doc, 700, [
    "Verizon Wireless, PO Box 408, Newark NJ 07101. Charges shown include surcharges and government fees.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 11 — the German invoice
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The whole point of this one is that it is priced in euros.
 *
 * A German-labelled invoice is the realistic way a foreign-currency document
 * reaches a US quarter: a European hosting bill lands in the same inbox as
 * everything else and nothing about the filename says it is not dollars. The
 * period is USD, so this must be flagged rather than added or converted — a
 * conversion needs a rate on a date, and no rate is stated anywhere here.
 */
function germanInvoice(cfg) {
  const doc = new Pdf();
  doc.page();
  const brand = [0.83, 0.12, 0.15];

  doc.text(M, 56, "Hetzner Online GmbH", { font: "Helvetica-Bold", size: 15, color: INK });
  doc.text(M, 72, "Industriestraße 25, 91710 Gunzenhausen, Deutschland", { size: 8.4, color: SOFT });
  doc.text(M, 84, "USt-IdNr. DE812871812 · Amtsgericht Ansbach HRB 6089", { size: 8.4, color: SOFT });
  doc.rect(R - 46, 44, 46, 8, { fill: brand });
  doc.textRight(R, 78, "RECHNUNG", { font: "Helvetica-Bold", size: 18, color: INK, charSpace: 1.4 });
  doc.line(M, 108, R, 108, { color: RULE, lineWidth: 0.8 });

  doc.text(M, 140, "RECHNUNGSEMPFÄNGER", { size: 7.4, color: SOFT, charSpace: 0.9 });
  doc.text(M, 158, ENTITY.name, { font: "Helvetica-Bold", size: 11, color: INK });
  doc.text(M, 174, ENTITY.street, { size: 9, color: SOFT });
  doc.text(M, 187, `${ENTITY.city}, USA`, { size: 9, color: SOFT });

  metaRows(doc, 336, 140, [
    ["RECHNUNGSNUMMER", cfg.number],
    ["RECHNUNGSDATUM", germanDate(cfg.issueDate)],
    ["KUNDENNUMMER", cfg.customer],
    ["LEISTUNGSZEITRAUM", `${germanDate(cfg.periodStart)} – ${germanDate(cfg.periodEnd)}`],
  ]);

  let y = tableHead(doc, 240, [
    [M, "BESCHREIBUNG"],
    [388, "MENGE", "right"],
    [462, "EINZELPREIS", "right"],
    [R, "BETRAG", "right"],
  ]);
  for (const item of cfg.lines) {
    doc.text(M, y, item.desc, { size: 9.6, color: INK });
    doc.textRight(388, y, item.qty, { size: 9.6, color: SOFT });
    doc.textRight(462, y, eur(item.unit), { size: 9.6, color: SOFT });
    doc.textRight(R, y, eur(item.amount), { size: 9.6, color: INK });
    y += 21;
  }
  doc.line(M, y - 4, R, y - 4, { color: RULE, lineWidth: 0.5 });
  y += 14;
  doc.textRight(486, y, "Nettobetrag", { size: 9.2, color: SOFT });
  doc.textRight(R, y, eur(cfg.net), { size: 9.2, color: INK });
  y += 16;
  doc.textRight(486, y, "Umsatzsteuer 19 %", { size: 9.2, color: SOFT });
  doc.textRight(R, y, eur(cfg.vat), { size: 9.2, color: INK });
  y += 18;
  totalBox(doc, y, "GESAMTBETRAG (EUR)", eur(cfg.total), { accent: brand, width: 250 });

  doc.text(M, y + 62, "Zahlung erfolgte per Lastschrift. Betrag in Euro; es wird kein Umrechnungskurs ausgewiesen.", {
    size: 8.6, color: SOFT,
  });
  doc.text(M, y + 76, "Alle Preise verstehen sich in Euro (EUR). Gebühren für Zusatzleistungen sind gesondert aufgeführt.", {
    size: 8.6, color: SOFT,
  });
  footNote(doc, 700, [
    "Hetzner Online GmbH · Geschäftsführer: Martin Hetzner · Sitz der Gesellschaft: Gunzenhausen.",
    "Diese Rechnung wurde maschinell erstellt und ist ohne Unterschrift gültig.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 12 — the mileage log
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A mileage log carries no money at all.
 *
 * That is what it is here to prove. The rate is a policy choice made at form
 * time, so the document states miles and purposes and nothing else, and the
 * pipeline has to carry a document with no `total` through extraction,
 * classification and reconciliation without inventing one to fill the column.
 */
function mileageLog(cfg) {
  const doc = new Pdf();
  doc.page();

  doc.text(M, 58, "BUSINESS MILEAGE LOG", {
    font: "Helvetica-Bold", size: 15, color: INK, charSpace: 1.6,
  });
  doc.text(M, 76, `${ENTITY.name} · ${PERIOD.label} · prepared from calendar and odometer readings`, {
    size: 8.6, color: SOFT,
  });
  doc.line(M, 96, R, 96, { color: RULE, lineWidth: 1.2 });

  metaRows(doc, M, 124, [
    ["DRIVER", cfg.driver],
    ["VEHICLE", cfg.vehicle],
    ["ODOMETER 1 JAN", cfg.odoStart],
  ], { valueRight: 300 });
  metaRows(doc, 372, 124, [
    ["ODOMETER 31 MAR", cfg.odoEnd],
    ["BUSINESS MILES", cfg.businessMiles],
    ["PERSONAL MILES", cfg.personalMiles],
  ]);

  let y = tableHead(doc, 208, [
    [M, "DATE"],
    [122, "FROM"],
    [254, "TO"],
    [402, "PURPOSE"],
    [R, "MILES", "right"],
  ]);
  for (const trip of cfg.trips) {
    doc.text(M, y, shortDate(trip.date), { size: 8.8, color: SOFT });
    doc.text(122, y, trip.from, { size: 8.8, color: INK });
    doc.text(254, y, trip.to, { size: 8.8, color: INK });
    doc.text(402, y, trip.purpose, { size: 8.8, color: SOFT });
    doc.textRight(R, y, String(trip.miles), { size: 8.8, color: INK });
    y += 16;
  }
  doc.line(M, y - 2, R, y - 2, { color: RULE, lineWidth: 0.5 });
  y += 16;
  doc.text(390, y, "Total business miles", { font: "Helvetica-Bold", size: 9.4, color: INK });
  doc.textRight(R, y, cfg.businessMiles, { font: "Helvetica-Bold", size: 11, color: INK });

  y += 38;
  doc.text(M, y, "No amount is stated on this log, and none should be inferred from it.", {
    font: "Helvetica-Bold", size: 9, color: INK,
  });
  doc.text(M, y + 15, "The deduction depends on whether the standard mileage rate or actual vehicle costs are claimed.", {
    size: 8.6, color: SOFT,
  });
  doc.text(M, y + 28, "The two methods give different figures and cannot be mixed, so the choice belongs to the preparer.", {
    size: 8.6, color: SOFT,
  });

  footNote(doc, 700, [
    "Kept contemporaneously. Trips under two miles and commuting between home and the Kettle Row office are excluded.",
  ]);
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout 13 — the image-only scan
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A page of path operators and nothing else.
 *
 * This fixture is the whole reason `unreadable` is a first-class extraction
 * status. It is what a phone photograph of a crumpled thermal taxi receipt
 * looks like once it has been dropped into a PDF: shapes, no text layer, no
 * figure anybody can read. The pipeline must put it on the exceptions list
 * under its own filename rather than guessing "taxi" from `scan_20250312`,
 * because a total inferred from a filename is a total nobody read off a
 * document.
 *
 * The strokes are generated from a fixed seed, so the file is byte-stable and
 * its hash does not move between runs.
 */
function scannedReceipt() {
  const doc = new Pdf();
  doc.page();

  // A small deterministic PRNG. Math.random would make every run produce a new
  // sha256 and the corpus would stop being reproducible.
  let seed = 20250312;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // The scan bed: a grey field with the paper sitting slightly askew on it.
  doc.rect(0, 0, W, 792, { fill: [0.85, 0.85, 0.86] });
  doc.rect(150, 120, 300, 560, { fill: [0.965, 0.955, 0.93], stroke: [0.72, 0.71, 0.68], lineWidth: 1.2 });

  // Creases: long straight-ish folds across the paper.
  const creases = [];
  for (let i = 0; i < 7; i += 1) {
    const y = 150 + i * 72 + rand() * 20;
    const points = [];
    for (let x = 152; x <= 448; x += 24) points.push([x, y + (rand() - 0.5) * 7]);
    creases.push({ points, curve: true, lineWidth: 0.5, color: [0.8, 0.79, 0.75] });
  }
  doc.sketch(creases);

  // The printed block at the top of a till receipt, reduced to unreadable bars.
  const bars = [];
  for (let i = 0; i < 5; i += 1) {
    const y = 168 + i * 13;
    const w = 90 + rand() * 110;
    bars.push({ points: [[175 + rand() * 30, y], [175 + w, y]], lineWidth: 3.4, color: [0.55, 0.54, 0.52] });
  }
  doc.sketch(bars);
  doc.line(172, 246, 428, 246, { color: [0.6, 0.59, 0.57], lineWidth: 0.8 });

  // Handwriting: loops and strokes with no glyph behind them.
  const hand = [];
  for (let row = 0; row < 9; row += 1) {
    const baseline = 286 + row * 34;
    let x = 182 + rand() * 20;
    while (x < 400 + rand() * 30) {
      const width = 12 + rand() * 22;
      const points = [];
      for (let t = 0; t <= 6; t += 1) {
        const p = t / 6;
        points.push([
          x + p * width,
          baseline - Math.sin(p * Math.PI * (1 + rand() * 1.4)) * (7 + rand() * 9) + (rand() - 0.5) * 3,
        ]);
      }
      hand.push({ points, curve: true, lineWidth: 1.1 + rand() * 0.7, color: [0.16, 0.19, 0.34] });
      x += width + 5 + rand() * 7;
    }
  }
  doc.sketch(hand);

  // A signature scrawl and a thumbed smudge, both paths.
  doc.sketch([
    {
      points: [
        [200, 604], [214, 578], [228, 612], [244, 572], [262, 610],
        [284, 576], [308, 606], [336, 582], [364, 600], [392, 588],
      ],
      curve: true,
      lineWidth: 1.8,
      color: [0.12, 0.14, 0.3],
    },
  ]);
  doc.line(196, 620, 400, 620, { color: [0.55, 0.55, 0.55], lineWidth: 0.7 });

  const smudge = [];
  for (let i = 0; i < 26; i += 1) {
    const cx = 330 + rand() * 60;
    const cy = 640 + rand() * 26;
    smudge.push({
      points: [[cx, cy], [cx + 6 + rand() * 10, cy + (rand() - 0.5) * 8]],
      lineWidth: 2 + rand() * 2,
      color: [0.72, 0.7, 0.66],
    });
  }
  doc.sketch(smudge);

  // A torn lower edge, drawn as one closed path.
  const tear = [[152, 672]];
  for (let x = 160; x <= 448; x += 16) tear.push([x, 668 + rand() * 12]);
  doc.sketch([{ points: tear, lineWidth: 1.1, color: [0.7, 0.69, 0.66] }]);

  return doc;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The corpus
 * ────────────────────────────────────────────────────────────────────────── */

const CLIENTS = {
  acme: ["Acme Robotics Inc.", ["Attn: Accounts Payable", "2200 Harrison Street", "Oakland, CA 94612"]],
  bluepeak: ["Bluepeak Health Systems", ["Finance Department", "455 Nicollet Mall, Floor 12", "Minneapolis, MN 55401"]],
  cormorant: ["Cormorant Ventures LP", ["c/o Platform Operations", "1 Letterman Drive, Building C", "San Francisco, CA 94129"]],
  delta: ["Delta Freight Co.", ["Accounts Payable", "8800 NE Alderwood Road", "Portland, OR 97220"]],
};

function outgoing({ number, client, issueDate, dueDate, project, lines, total, ...rest }) {
  const [name, address] = CLIENTS[client];
  return northwindInvoice({
    number,
    client: name,
    clientAddress: address,
    issueDate,
    dueDate,
    project,
    lines,
    subtotal: total,
    tax: 0,
    taxLabel: "Sales tax (OR, services exempt)",
    total,
    ...rest,
  });
}

/**
 * Every fixture, in ingest order.
 *
 * `truth` is what a correct extraction returns. `expectedExceptions` lists the
 * flags that should end up attached to this document; the register-level count
 * comes from `EXPECTED_FINDINGS` below, because one finding can name two files.
 *
 * `probes` are strings the verifier looks for in the raw, uncompressed stream.
 * They must not contain `(`, `)` or `\`: those are backslash-escaped on the way
 * into a PDF string, so a probe containing one would never match a file that is
 * perfectly correct.
 */
const DOCUMENTS = [
  /* ── Revenue Northwind issued ─────────────────────────────────────────── */
  {
    id: "doc_f01",
    file: "INV-2025-001 Acme Robotics.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Invoices out",
    sourceRef: "1aQ7nR-northwind-inv-2025-001",
    probes: ["INV-2025-001", "Acme Robotics Inc.", "$12,500.00"],
    truth: {
      vendor: "Acme Robotics Inc.", issueDate: "2025-01-08", invoiceNumber: "INV-2025-001",
      total: 12500, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-001", client: "acme", issueDate: "2025-01-08", dueDate: "2025-01-23",
      project: "Atlas platform", total: 12500,
      lines: [
        { desc: "Web platform design — discovery and IA", note: "Sprints 1–2, January", qty: "40.0", rate: "$150.00", amount: 6000 },
        { desc: "Interface design system", note: "Component library, 24 patterns", qty: "30.0", rate: "$150.00", amount: 4500 },
        { desc: "Prototype build and handover", qty: "13.3", rate: "$150.00", amount: 2000 },
      ],
    }),
  },
  {
    id: "doc_f02",
    file: "INV-2025-002 Bluepeak Health.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Invoices out",
    sourceRef: "1aQ7nR-northwind-inv-2025-002",
    probes: ["INV-2025-002", "Bluepeak Health Systems", "$8,400.00"],
    truth: {
      vendor: "Bluepeak Health Systems", issueDate: "2025-01-15", invoiceNumber: "INV-2025-002",
      total: 8400, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-002", client: "bluepeak", issueDate: "2025-01-15", dueDate: "2025-01-30",
      project: "Care portal retainer", total: 8400,
      lines: [
        { desc: "Monthly design retainer — January", note: "56 hours, product and research", qty: "1", rate: "$8,400.00", amount: 8400 },
      ],
    }),
  },
  {
    id: "doc_f03",
    file: "INV-2025-003 Cormorant Ventures.pdf",
    source: "gmail",
    sourceDetail: "sent: accounts@northwind.studio → ap@cormorant.vc",
    sourceRef: "msg-18f2c9a1b0e3",
    probes: ["INV-2025-003", "Cormorant Ventures LP", "$15,000.00"],
    truth: {
      vendor: "Cormorant Ventures LP", issueDate: "2025-02-04", invoiceNumber: "INV-2025-003",
      total: 15000, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-003", client: "cormorant", issueDate: "2025-02-04", dueDate: "2025-02-19",
      project: "Brand system", total: 15000,
      lines: [
        { desc: "Brand strategy and positioning", qty: "1", rate: "$4,500.00", amount: 4500 },
        { desc: "Identity design — marque, type, palette", qty: "1", rate: "$7,500.00", amount: 7500 },
        { desc: "Brand guidelines and asset library", qty: "1", rate: "$3,000.00", amount: 3000 },
      ],
    }),
  },
  {
    id: "doc_f04",
    file: "INV-2025-004 Acme Robotics.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Invoices out",
    sourceRef: "1aQ7nR-northwind-inv-2025-004",
    probes: ["INV-2025-004", "$12,500.00"],
    truth: {
      vendor: "Acme Robotics Inc.", issueDate: "2025-02-08", invoiceNumber: "INV-2025-004",
      total: 12500, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-004", client: "acme", issueDate: "2025-02-08", dueDate: "2025-02-23",
      project: "Atlas platform", total: 12500,
      lines: [
        { desc: "Monthly retainer — February", note: "Platform design, 83.3 hours at $150.00", qty: "1", rate: "$12,500.00", amount: 12500 },
      ],
    }),
  },
  {
    id: "doc_f05",
    file: "INV-2025-005 Bluepeak Health.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Invoices out",
    sourceRef: "1aQ7nR-northwind-inv-2025-005",
    probes: ["INV-2025-005", "$8,400.00"],
    truth: {
      vendor: "Bluepeak Health Systems", issueDate: "2025-02-15", invoiceNumber: "INV-2025-005",
      total: 8400, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-005", client: "bluepeak", issueDate: "2025-02-15", dueDate: "2025-03-02",
      project: "Care portal retainer", total: 8400,
      lines: [
        { desc: "Monthly design retainer — February", note: "56 hours, product and research", qty: "1", rate: "$8,400.00", amount: 8400 },
      ],
    }),
  },
  {
    id: "doc_f06",
    file: "INV-2025-006 Delta Freight Co.pdf",
    source: "gmail",
    sourceDetail: "sent: accounts@northwind.studio → ap@deltafreight.co",
    sourceRef: "msg-18f5d1c4a992",
    probes: ["INV-2025-006", "Delta Freight Co.", "$6,750.00"],
    truth: {
      vendor: "Delta Freight Co.", issueDate: "2025-03-06", invoiceNumber: "INV-2025-006",
      total: 6750, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-006", client: "delta", issueDate: "2025-03-06", dueDate: "2025-03-21",
      project: "Logistics dashboard", total: 6750,
      lines: [
        { desc: "Logistics dashboard — design and build", note: "Phase 1: fleet status and exception views", qty: "45.0", rate: "$150.00", amount: 6750 },
      ],
    }),
  },
  {
    id: "doc_f07",
    file: "INV-2025-007 Bluepeak Health.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Invoices out",
    sourceRef: "1aQ7nR-northwind-inv-2025-007",
    probes: ["INV-2025-007", "$8,400.00"],
    truth: {
      vendor: "Bluepeak Health Systems", issueDate: "2025-03-15", invoiceNumber: "INV-2025-007",
      total: 8400, currency: "USD", direction: "income", docType: "invoice-issued",
      expectedCategoryId: "income-services",
    },
    expectedExceptions: [],
    build: () => outgoing({
      number: "INV-2025-007", client: "bluepeak", issueDate: "2025-03-15", dueDate: "2025-03-30",
      project: "Care portal retainer", total: 8400,
      lines: [
        { desc: "Monthly design retainer — March", note: "56 hours, product and research", qty: "1", rate: "$8,400.00", amount: 8400 },
      ],
    }),
  },
  {
    id: "doc_f08",
    file: "CN-2025-001 Delta Freight credit note.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Credit notes",
    sourceRef: "1aQ7nR-northwind-cn-2025-001",
    probes: ["CN-2025-001", "CREDIT NOTE", "-$750.00"],
    truth: {
      vendor: "Delta Freight Co.", issueDate: "2025-03-24", invoiceNumber: "CN-2025-001",
      total: -750, currency: "USD", direction: "income", docType: "credit-note",
      expectedCategoryId: "income-refunds",
    },
    expectedExceptions: [],
    build: () => northwindCreditNote({
      number: "CN-2025-001",
      client: CLIENTS.delta[0],
      clientAddress: CLIENTS.delta[1],
      issueDate: "2025-03-24",
      dueDate: "2025-03-24",
      terms: "Credit — no payment due",
      project: "Logistics dashboard",
      lines: [
        { desc: "Scope reduction — driver mobile view withdrawn", note: "Against INV-2025-006, 5.0 hours at $150.00", qty: "-5.0", rate: "$150.00", amount: -750 },
      ],
      subtotal: -750,
      tax: 0,
      taxLabel: "Sales tax",
      total: -750,
      footer: ["This credit note reduces gross receipts. It is not a refund of cash paid; it is applied against INV-2025-006."],
    }),
  },
  {
    id: "doc_f09",
    file: "stripe-payout-statement-feb-2025.pdf",
    source: "gmail",
    sourceDetail: "from: receipts@stripe.com",
    sourceRef: "msg-18f7a3b21c40",
    probes: ["Payout report", "$20,900.00", "$611.20", "$20,288.80"],
    truth: {
      vendor: "Stripe", issueDate: "2025-02-28", invoiceNumber: "po_1QxNwFeb25",
      total: 611.2, currency: "USD", direction: "expense", docType: "payout-report",
      expectedCategoryId: "expense-commissions",
      note: "Gross volume 20,900.00 is revenue already invoiced; the deductible figure on this statement is the 611.20 of processing fees.",
    },
    expectedExceptions: [],
    build: () => stripePayout({
      payoutId: "po_1QxNwFeb25",
      paidOn: "2025-02-28",
      periodLabel: "1 – 28 February 2025",
      gross: 20900,
      fees: 611.2,
      net: 20288.8,
      chargeCount: 4,
      charges: [
        { date: "2025-02-05", customer: "Acme Robotics Inc.", chargeId: "ch_3Qa71kFeb0001", fee: 187.4, gross: 6400 },
        { date: "2025-02-12", customer: "Bluepeak Health Systems", chargeId: "ch_3Qa71kFeb0002", fee: 246.9, gross: 8400 },
        { date: "2025-02-19", customer: "Cormorant Ventures LP", chargeId: "ch_3Qa71kFeb0003", fee: 132.4, gross: 4500 },
        { date: "2025-02-26", customer: "Delta Freight Co.", chargeId: "ch_3Qa71kFeb0004", fee: 44.5, gross: 1600 },
      ],
    }),
  },

  /* ── Clean expenses ───────────────────────────────────────────────────── */
  {
    id: "doc_f10",
    file: "aws-invoice-jan-2025.pdf",
    source: "gmail",
    sourceDetail: "from: billing@amazonaws.com",
    sourceRef: "msg-18e9c4d5f001",
    probes: ["Amazon Web Services, Inc.", "4417-2290-1183", "$1,842.19"],
    truth: {
      vendor: "Amazon Web Services, Inc.", issueDate: "2025-01-03", invoiceNumber: "INV-AWS-JAN25",
      total: 1842.19, subtotal: 1697.36, tax: 144.83, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-office",
    },
    expectedExceptions: ["ledger-amount-mismatch"],
    build: () => awsInvoice({
      number: "INV-AWS-JAN25",
      account: "4417-2290-1183",
      issueDate: "2025-01-03",
      periodStart: "2024-12-01",
      periodEnd: "2024-12-31",
      subtotal: 1697.36,
      tax: 144.83,
      total: 1842.19,
      services: [
        { service: "Amazon Elastic Compute Cloud", region: "US West (Oregon)", usage: "1,488 hrs m6i.xlarge", amount: 742.11 },
        { service: "Amazon Relational Database Service", region: "US West (Oregon)", usage: "744 hrs db.r6g.large", amount: 418.9 },
        { service: "Amazon Simple Storage Service", region: "US West (Oregon)", usage: "4.21 TB-month", amount: 96.83 },
        { service: "Amazon CloudFront", region: "Global", usage: "2.88 TB data transfer", amount: 244.52 },
        { service: "AWS Key Management Service", region: "US West (Oregon)", usage: "18 keys", amount: 18.0 },
        { service: "Amazon Route 53", region: "Global", usage: "14 hosted zones", amount: 7.0 },
        { service: "AWS Support (Developer)", region: "Global", usage: "Monthly subscription", amount: 170.0 },
      ],
    }),
  },
  {
    id: "doc_f11",
    file: "aws-invoice-feb-2025.pdf",
    source: "gmail",
    sourceDetail: "from: billing@amazonaws.com",
    sourceRef: "msg-18ec71a9b220",
    probes: ["Amazon Web Services, Inc.", "$2,014.55"],
    truth: {
      vendor: "Amazon Web Services, Inc.", issueDate: "2025-02-03", invoiceNumber: "INV-AWS-FEB25",
      total: 2014.55, subtotal: 1856.5, tax: 158.05, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-office",
    },
    expectedExceptions: [],
    build: () => awsInvoice({
      number: "INV-AWS-FEB25",
      account: "4417-2290-1183",
      issueDate: "2025-02-03",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      subtotal: 1856.5,
      tax: 158.05,
      total: 2014.55,
      services: [
        { service: "Amazon Elastic Compute Cloud", region: "US West (Oregon)", usage: "1,488 hrs m6i.xlarge", amount: 812.44 },
        { service: "Amazon Relational Database Service", region: "US West (Oregon)", usage: "744 hrs db.r6g.large", amount: 418.9 },
        { service: "Amazon Simple Storage Service", region: "US West (Oregon)", usage: "4.66 TB-month", amount: 107.16 },
        { service: "Amazon CloudFront", region: "Global", usage: "3.41 TB data transfer", amount: 289.0 },
        { service: "AWS Key Management Service", region: "US West (Oregon)", usage: "18 keys", amount: 18.0 },
        { service: "Amazon Route 53", region: "Global", usage: "14 hosted zones", amount: 7.0 },
        { service: "AWS Support (Developer)", region: "Global", usage: "Monthly subscription", amount: 204.0 },
      ],
    }),
  },
  {
    id: "doc_f12",
    file: "figma-organization-annual.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Software",
    sourceRef: "1gW3rX-figma-organization-annual",
    probes: ["Figma, Inc.", "$1,080.00"],
    truth: {
      vendor: "Figma, Inc.", issueDate: "2025-01-11", invoiceNumber: "FIG-2025-4471",
      total: 1080, subtotal: 1080, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: [],
    build: () => saasReceipt({
      vendor: "Figma, Inc.",
      vendorAddress: "760 Market Street, Floor 10, San Francisco, CA 94102",
      accent: [0.95, 0.32, 0.19],
      number: "FIG-2025-4471",
      issueDate: "2025-01-11",
      plan: "Organization — annual",
      cycle: "Annual, renews 11 Jan 2026",
      periodStart: "2025-01-11",
      periodEnd: "2026-01-10",
      subtotal: 1080,
      tax: 0,
      taxLabel: "Sales tax (exempt, certificate on file)",
      total: 1080,
      lines: [
        { desc: "Design seats — annual", qty: "4", unit: "$180.00", amount: 720 },
        { desc: "Dev Mode seats — annual", qty: "2", unit: "$180.00", amount: 360 },
      ],
    }),
  },
  {
    id: "doc_f13",
    file: "google-workspace-jan.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Software",
    sourceRef: "1gW3rX-google-workspace-jan",
    probes: ["Google Workspace", "$180.00", "GW-JAN-2025"],
    truth: {
      vendor: "Google LLC", issueDate: "2025-01-02", invoiceNumber: "GW-JAN-2025",
      total: 180, subtotal: 180, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: [],
    build: () => saasReceipt({
      vendor: "Google Workspace",
      vendorAddress: "Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043",
      accent: [0.26, 0.45, 0.88],
      number: "GW-JAN-2025",
      issueDate: "2025-01-02",
      plan: "Business Standard",
      cycle: "Monthly",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      subtotal: 180,
      tax: 0,
      total: 180,
      lines: [{ desc: "Business Standard — January 2025", qty: "12", unit: "$15.00", amount: 180 }],
    }),
  },
  {
    id: "doc_f14",
    file: "google-workspace-feb.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Software",
    sourceRef: "1gW3rX-google-workspace-feb",
    probes: ["Google Workspace", "$180.00", "GW-FEB-2025"],
    truth: {
      vendor: "Google LLC", issueDate: "2025-02-02", invoiceNumber: "GW-FEB-2025",
      total: 180, subtotal: 180, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: [],
    build: () => saasReceipt({
      vendor: "Google Workspace",
      vendorAddress: "Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043",
      accent: [0.26, 0.45, 0.88],
      number: "GW-FEB-2025",
      issueDate: "2025-02-02",
      plan: "Business Standard",
      cycle: "Monthly",
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      subtotal: 180,
      tax: 0,
      total: 180,
      lines: [{ desc: "Business Standard — February 2025", qty: "12", unit: "$15.00", amount: 180 }],
    }),
  },
  {
    id: "doc_f15",
    file: "google-workspace-mar.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Software",
    sourceRef: "1gW3rX-google-workspace-mar",
    probes: ["Google Workspace", "$180.00", "GW-MAR-2025"],
    truth: {
      vendor: "Google LLC", issueDate: "2025-03-02", invoiceNumber: "GW-MAR-2025",
      total: 180, subtotal: 180, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: [],
    build: () => saasReceipt({
      vendor: "Google Workspace",
      vendorAddress: "Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043",
      accent: [0.26, 0.45, 0.88],
      number: "GW-MAR-2025",
      issueDate: "2025-03-02",
      plan: "Business Standard",
      cycle: "Monthly",
      periodStart: "2025-03-01",
      periodEnd: "2025-03-31",
      subtotal: 180,
      tax: 0,
      total: 180,
      lines: [{ desc: "Business Standard — March 2025", qty: "12", unit: "$15.00", amount: 180 }],
    }),
  },
  {
    id: "doc_f16",
    file: "wework-jan-2025.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Rent",
    sourceRef: "1bR8mS-wework-jan-2025",
    probes: ["WeWork", "$1,400.00", "WW-2025-0101"],
    truth: {
      vendor: "WeWork", issueDate: "2025-01-01", invoiceNumber: "WW-2025-0101",
      total: 1400, subtotal: 1400, tax: 0, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-rent-property",
    },
    expectedExceptions: [],
    build: () => supplierInvoice({
      vendor: "WeWork",
      tagline: "Custom Bay · 1120 NW Couch Street, Portland",
      vendorAddress: ["WeWork Companies LLC", "75 Rockefeller Plaza, New York, NY 10019", "billing@wework.com"],
      accent: [0.1, 0.1, 0.12],
      number: "WW-2025-0101",
      issueDate: "2025-01-01",
      dueDate: "2025-01-01",
      terms: "Due on receipt — autopay",
      reference: "Membership 4471-PDX",
      subtotal: 1400,
      tax: 0,
      total: 1400,
      lines: [
        { desc: "Dedicated desk — January 2025", note: "4 desks, Custom Bay, floor 3", qty: "4", unit: "$350.00", amount: 1400 },
      ],
      body: "Membership continues month to month. Cancellation requires notice before the 25th of the preceding month.",
    }),
  },
  {
    id: "doc_f17",
    file: "wework-feb-2025.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Rent",
    sourceRef: "1bR8mS-wework-feb-2025",
    probes: ["WeWork", "$1,400.00", "WW-2025-0201"],
    truth: {
      vendor: "WeWork", issueDate: "2025-02-01", invoiceNumber: "WW-2025-0201",
      total: 1400, subtotal: 1400, tax: 0, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-rent-property",
    },
    expectedExceptions: [],
    build: () => supplierInvoice({
      vendor: "WeWork",
      tagline: "Custom Bay · 1120 NW Couch Street, Portland",
      vendorAddress: ["WeWork Companies LLC", "75 Rockefeller Plaza, New York, NY 10019", "billing@wework.com"],
      accent: [0.1, 0.1, 0.12],
      number: "WW-2025-0201",
      issueDate: "2025-02-01",
      dueDate: "2025-02-01",
      terms: "Due on receipt — autopay",
      reference: "Membership 4471-PDX",
      subtotal: 1400,
      tax: 0,
      total: 1400,
      lines: [
        { desc: "Dedicated desk — February 2025", note: "4 desks, Custom Bay, floor 3", qty: "4", unit: "$350.00", amount: 1400 },
      ],
      body: "Membership continues month to month. Cancellation requires notice before the 25th of the preceding month.",
    }),
  },
  {
    id: "doc_f18",
    file: "wework-mar-2025.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Rent",
    sourceRef: "1bR8mS-wework-mar-2025",
    probes: ["WeWork", "$1,400.00", "WW-2025-0301"],
    truth: {
      vendor: "WeWork", issueDate: "2025-03-01", invoiceNumber: "WW-2025-0301",
      total: 1400, subtotal: 1400, tax: 0, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-rent-property",
    },
    expectedExceptions: [],
    build: () => supplierInvoice({
      vendor: "WeWork",
      tagline: "Custom Bay · 1120 NW Couch Street, Portland",
      vendorAddress: ["WeWork Companies LLC", "75 Rockefeller Plaza, New York, NY 10019", "billing@wework.com"],
      accent: [0.1, 0.1, 0.12],
      number: "WW-2025-0301",
      issueDate: "2025-03-01",
      dueDate: "2025-03-01",
      terms: "Due on receipt — autopay",
      reference: "Membership 4471-PDX",
      subtotal: 1400,
      tax: 0,
      total: 1400,
      lines: [
        { desc: "Dedicated desk — March 2025", note: "4 desks, Custom Bay, floor 3", qty: "4", unit: "$350.00", amount: 1400 },
      ],
      body: "Membership continues month to month. Cancellation requires notice before the 25th of the preceding month.",
    }),
  },
  {
    id: "doc_f19",
    file: "statefarm-business-liability.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Insurance",
    sourceRef: "1cS9nT-statefarm-gl-q1",
    probes: ["State Farm", "$1,260.00", "97-BL-4471-08"],
    truth: {
      vendor: "State Farm Fire and Casualty Company", issueDate: "2025-01-20", invoiceNumber: "97-BL-4471-08",
      total: 1260, currency: "USD", direction: "expense", docType: "statement",
      expectedCategoryId: "expense-insurance",
    },
    expectedExceptions: [],
    build: () => insuranceSchedule({
      insurer: "State Farm",
      insurerAddress: "State Farm Fire and Casualty Company, One State Farm Plaza, Bloomington, IL 61710",
      title: "BUSINESS LIABILITY PREMIUM NOTICE",
      policy: "97-BL-4471-08",
      issueDate: "2025-01-20",
      coverFrom: "2025-02-01",
      coverTo: "2026-01-31",
      agent: "K. Otieno, Portland OR",
      tableTitle: "Coverage and premium",
      coverages: [
        { name: "General liability — each occurrence", limit: "$1,000,000", premium: 640 },
        { name: "General aggregate", limit: "$2,000,000", premium: 285 },
        { name: "Products and completed operations", limit: "$2,000,000", premium: 145 },
        { name: "Damage to premises rented", limit: "$300,000", premium: 90 },
        { name: "Professional liability endorsement", limit: "$500,000", premium: 100 },
      ],
      total: 1260,
      body: "Premium is payable annually in advance. This notice covers general liability only; health cover is not part of this policy.",
    }),
  },
  {
    id: "doc_f20",
    file: "harbor-legal-llp-invoice-2291.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Professional services",
    sourceRef: "1hX4sY-harbor-legal-2291",
    probes: ["Harbor Legal LLP", "$950.00", "2291"],
    truth: {
      vendor: "Harbor Legal LLP", issueDate: "2025-02-19", invoiceNumber: "2291",
      total: 950, subtotal: 950, tax: 0, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-professional",
      vendorTaxId: "93-2210447",
    },
    expectedExceptions: [],
    build: () => supplierInvoice({
      vendor: "Harbor Legal LLP",
      tagline: "Commercial and technology counsel",
      vendorAddress: ["1000 SW Broadway, Suite 1400", "Portland, OR 97205", "billing@harborlegal.com · (503) 555-0188"],
      accent: [0.13, 0.24, 0.36],
      number: "2291",
      issueDate: "2025-02-19",
      dueDate: "2025-03-21",
      terms: "Net 30",
      vendorTaxId: "93-2210447",
      reference: "Matter 2025-0114",
      hours: true,
      subtotal: 950,
      tax: 0,
      taxLabel: "Sales tax (services, OR)",
      total: 950,
      lines: [
        { desc: "Review and mark-up, Cormorant master services agreement", qty: "2.4", unit: "$250.00", amount: 600 },
        { desc: "Call with client re: IP assignment clause", qty: "0.6", unit: "$250.00", amount: 150 },
        { desc: "Revised statement of work template", qty: "0.8", unit: "$250.00", amount: 200 },
      ],
      body: "Time is billed in six-minute increments. Disbursements, if any, are itemised separately.",
    }),
  },
  {
    id: "doc_f21",
    file: "staples-receipt-2025-02-11.pdf",
    source: "upload",
    sourceDetail: "photographed and uploaded by the office manager",
    sourceRef: "upload-staples-0211",
    probes: ["STAPLES", "87.43"],
    truth: {
      vendor: "Staples", issueDate: "2025-02-11", invoiceNumber: "4471-0092",
      total: 87.43, subtotal: 80.03, tax: 7.4, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-supplies",
    },
    expectedExceptions: [],
    build: () => tillReceipt({
      store: "STAPLES",
      storeAddress: ["STORE 1188 - PORTLAND NW", "1140 NW COUCH ST", "PORTLAND OR 97209", "(503) 555-0113"],
      issueDate: "2025-02-11",
      time: "14:22",
      storeNumber: "1188",
      txn: "4471-0092",
      height: 540,
      items: [
        { desc: "HAMMERMILL A4 500SH", amount: 12.99, note: "2 @ 6.4950" },
        { desc: "PILOT G2 GEL 12PK", amount: 15.49 },
        { desc: "POST-IT 3X3 18PK", amount: 21.99 },
        { desc: "HP 63XL BLACK INK", amount: 21.56, note: "PROMO -4.43 APPLIED" },
        { desc: "AVERY FILE FOLDER 25", amount: 8.0 },
      ],
      totals: [
        ["SUBTOTAL", "80.03"],
        ["OR TAX 0.000%", "0.00"],
        ["RECYCLING FEE", "7.40"],
        ["TOTAL", "$87.43", true],
        ["VISA ****4471", "87.43"],
        ["AUTH 004182", ""],
      ],
      tail: ["THANK YOU FOR SHOPPING STAPLES", "RETURNS WITHIN 30 DAYS WITH RECEIPT", "SURVEY: WWW.STAPLES.COM/SURVEY"],
    }),
  },
  {
    id: "doc_f22",
    file: "delta-air-eticket-2025-03-03.pdf",
    source: "gmail",
    sourceDetail: "from: DeltaAirLines@e.delta.com",
    sourceRef: "msg-18f1c0d4e881",
    probes: ["ELECTRONIC TICKET RECEIPT", "$612.40", "PDX"],
    truth: {
      vendor: "Delta Air Lines, Inc.", issueDate: "2025-03-03", invoiceNumber: "0062418833901",
      total: 612.4, currency: "USD", direction: "expense", docType: "receipt",
      expectedCategoryId: "expense-travel",
    },
    expectedExceptions: [],
    build: () => eTicket({
      recordLocator: "HQ4T2M",
      passenger: "WHITFIELD / MARA R",
      ticket: "0062418833901",
      issueDate: "2025-03-03",
      skymiles: "SM 9042 118 447",
      fareBasis: "VA21A0MC",
      legs: [
        {
          flight: "DL 2214", date: "2025-03-04", from: "PDX Portland", to: "SFO San Francisco",
          depart: "07:05", arrive: "09:02", cabin: "Main Cabin (V)", aircraft: "Airbus A220-100", seat: "14C",
        },
        {
          flight: "DL 1877", date: "2025-03-06", from: "SFO San Francisco", to: "PDX Portland",
          depart: "18:40", arrive: "20:41", cabin: "Main Cabin (V)", aircraft: "Boeing 737-900ER", seat: "22A",
        },
      ],
      fare: [
        ["Base fare", 498.0],
        ["US transportation tax (7.5%)", 37.35],
        ["September 11th security fee", 11.2],
        ["Passenger facility charges", 9.0],
        ["US flight segment tax", 10.4],
        ["Seat selection, two segments", 46.45],
      ],
      total: 612.4,
    }),
  },
  {
    id: "doc_f23",
    file: "hotel-folio-hyatt-sf.pdf",
    source: "upload",
    sourceDetail: "emailed by the hotel, forwarded and uploaded",
    sourceRef: "upload-hyatt-folio-884213",
    probes: ["GUEST FOLIO", "$884.00", "884213"],
    truth: {
      vendor: "Hyatt Regency San Francisco", issueDate: "2025-03-05", invoiceNumber: "884213",
      total: 884, currency: "USD", direction: "expense", docType: "receipt",
      expectedCategoryId: "expense-travel",
      note: "The folio shows a balance of 0.00 because it was settled to the card on departure. The expense is the 884.00 of total charges, not the balance.",
    },
    expectedExceptions: [],
    build: () => hotelFolio({
      hotel: "HYATT REGENCY SAN FRANCISCO",
      hotelAddress: "5 Embarcadero Center, San Francisco, CA 94111",
      hotelPhone: "(415) 555-1234 · sfo.regency@hyatt.com",
      folio: "884213",
      guest: "WHITFIELD, MARA",
      room: "1408 — King, Bay View",
      ratePlan: "Corporate LRA — NWS4471",
      arrival: "2025-03-04",
      departure: "2025-03-06",
      nights: 2,
      confirmation: "H8842137",
      card: "Visa ending 4471",
      rows: [
        { date: "2025-03-04", desc: "Guest room — King, Bay View", charge: 349.0 },
        { date: "2025-03-04", desc: "SF transient occupancy tax 14%", charge: 48.86 },
        { date: "2025-03-04", desc: "SF tourism improvement district", charge: 9.62 },
        { date: "2025-03-05", desc: "Guest room — King, Bay View", charge: 349.0 },
        { date: "2025-03-05", desc: "SF transient occupancy tax 14%", charge: 48.86 },
        { date: "2025-03-05", desc: "SF tourism improvement district", charge: 9.62 },
        { date: "2025-03-05", desc: "In-room internet (complimentary, World of Hyatt)", charge: 0 },
        { date: "2025-03-06", desc: "Payment — Visa ending 4471", credit: -884.0 },
      ],
      total: 884.0,
      paid: 884.0,
    }),
  },
  {
    id: "doc_f24",
    file: "receipt-cascade-kitchen.pdf",
    source: "upload",
    sourceDetail: "photographed and uploaded by the office manager",
    sourceRef: "upload-cascade-0304",
    probes: ["CASCADE KITCHEN", "214.60", "GUESTS: 4"],
    truth: {
      vendor: "Cascade Kitchen", issueDate: "2025-03-04", invoiceNumber: "CK-0318",
      total: 214.6, subtotal: 172.0, tax: 8.6, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-meals",
      note: "Business meals reach the return at 50%. The recorded amount is 214.60; the deductible amount is 107.30.",
    },
    expectedExceptions: [],
    build: () => tillReceipt({
      store: "CASCADE KITCHEN",
      storeAddress: ["413 SW 12TH AVE", "PORTLAND OR 97205", "(503) 555-0176"],
      issueDate: "2025-03-04",
      time: "12:48",
      storeNumber: "01",
      txn: "CK-0318",
      height: 520,
      items: [
        { desc: "SERVER: RENATA  TABLE 6", amount: 0, note: "GUESTS: 4" },
        { desc: "ROASTED SQUASH SOUP x2", amount: 24.0 },
        { desc: "DUNGENESS CRAB ROLL x2", amount: 46.0 },
        { desc: "MUSHROOM TARTINE", amount: 21.0 },
        { desc: "STEELHEAD PLATE", amount: 32.0 },
        { desc: "SEASONAL GREENS x2", amount: 22.0 },
        { desc: "SPARKLING WATER x4", amount: 16.0 },
        { desc: "COFFEE x4", amount: 15.0 },
      ],
      totals: [
        ["SUBTOTAL", "172.00"],
        ["SVC CHARGE 20%", "34.00"],
        ["TAX", "8.60"],
        ["TOTAL", "$214.60", true],
        ["AMEX ****1007", "214.60"],
        ["AUTH 771204", ""],
      ],
      tail: ["BUSINESS LUNCH - ACME ROBOTICS", "ATTENDEES NOTED ON REVERSE", "THANK YOU"],
    }),
  },

  /* ── The ones that must be flagged ────────────────────────────────────── */
  {
    id: "doc_f25",
    file: "adobe-cc-feb-2025.pdf",
    source: "gmail",
    sourceDetail: "from: message@adobe.com",
    sourceRef: "msg-18ec0b1177a4",
    probes: ["Adobe Inc.", "ADB-88214", "$59.99"],
    truth: {
      vendor: "Adobe Inc.", issueDate: "2025-02-06", invoiceNumber: "ADB-88214",
      total: 59.99, subtotal: 59.99, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: ["duplicate-document"],
    build: () => saasReceipt({
      vendor: "Adobe Inc.",
      vendorAddress: "345 Park Avenue, San Jose, CA 95110-2704",
      accent: [0.92, 0.11, 0.14],
      number: "ADB-88214",
      issueDate: "2025-02-06",
      plan: "Creative Cloud All Apps — Teams",
      cycle: "Monthly, annual commitment",
      periodStart: "2025-02-06",
      periodEnd: "2025-03-05",
      subtotal: 59.99,
      tax: 0,
      taxLabel: "Sales tax (services, OR)",
      total: 59.99,
      card: "Visa ending 4471",
      lines: [{ desc: "Creative Cloud All Apps — 1 licence", qty: "1", unit: "$59.99", amount: 59.99 }],
      footer: [
        "Adobe Inc. — retain this receipt for your records. VAT/GST is not applicable to this transaction.",
        "Your plan renews on 6 March 2025 unless cancelled from the Adobe Admin Console.",
      ],
    }),
  },
  {
    id: "doc_f26",
    file: "Adobe_Invoice_ADB-88214 (1).pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Software — saved a second time from the same email",
    sourceRef: "1dT0oU-adobe-invoice-adb-88214-1",
    probes: ["Adobe Inc.", "ADB-88214", "$59.99"],
    /** Byte-identical to f25, so the hash check has something to find. */
    copyOf: "doc_f25",
    truth: {
      vendor: "Adobe Inc.", issueDate: "2025-02-06", invoiceNumber: "ADB-88214",
      total: 59.99, subtotal: 59.99, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "expense-office",
    },
    expectedExceptions: ["duplicate-document", "unmatched-document"],
  },
  {
    id: "doc_f27",
    file: "northgate-print-invoice-4471.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Marketing",
    sourceRef: "1iY5tZ-northgate-print-4471",
    probes: ["Northgate Print Works", "$900.00", "$72.00", "$927.00"],
    truth: {
      vendor: "Northgate Print Works", issueDate: "2025-02-21", invoiceNumber: "4471",
      subtotal: 900, tax: 72, total: 927, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-advertising",
      note: "The arithmetic does not hold: 900.00 + 72.00 is 972.00, and the invoice prints 927.00. Extract what is printed; do not correct it.",
    },
    expectedExceptions: ["total-mismatch"],
    build: () => supplierInvoice({
      vendor: "Northgate Print Works",
      tagline: "Litho and digital printing since 1978",
      vendorAddress: ["2210 N Interstate Avenue", "Portland, OR 97227", "accounts@northgateprint.com · (503) 555-0155"],
      accent: [0.19, 0.31, 0.2],
      number: "4471",
      issueDate: "2025-02-21",
      dueDate: "2025-03-23",
      terms: "Net 30",
      reference: "Job 25-0338",
      subtotal: 900,
      tax: 72,
      taxLabel: "Sales tax (WA delivery, 8.0%)",
      // 900.00 + 72.00 is 972.00. The printed figure transposes the last two
      // digits, which is the commonest arithmetic slip on a hand-keyed invoice
      // and the one a reviewer's eye slides straight past.
      total: 927,
      lines: [
        { desc: "Capability brochures — 8pp, 200gsm silk", note: "1,000 units, trimmed and folded", qty: "1,000", unit: "$0.62", amount: 620 },
        { desc: "Business cards — 400gsm, duplex", qty: "1,500", unit: "$0.10", amount: 150 },
        { desc: "Exhibition banner — 2m roll-up", qty: "2", unit: "$45.00", amount: 90 },
        { desc: "Delivery to Seattle stand", qty: "1", unit: "$40.00", amount: 40 },
      ],
      body: "Goods remain the property of Northgate Print Works until paid in full.",
    }),
  },
  {
    id: "doc_f28",
    file: "hetzner-rechnung-2025-03.pdf",
    source: "gmail",
    sourceDetail: "from: rechnung@hetzner.com",
    sourceRef: "msg-18f0aa3311d6",
    probes: ["Hetzner Online GmbH", "RECHNUNG", "GESAMTBETRAG"],
    truth: {
      vendor: "Hetzner Online GmbH", issueDate: "2025-03-05", invoiceNumber: "R0025883149",
      subtotal: 74.79, tax: 14.21, total: 89.0, currency: "EUR",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-office",
      note: "Priced in euros. The period is USD, so this is flagged rather than converted — no exchange rate is stated on the document.",
    },
    expectedExceptions: ["currency-mismatch"],
    build: () => germanInvoice({
      number: "R0025883149",
      issueDate: "2025-03-05",
      customer: "K4471209",
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      net: 74.79,
      vat: 14.21,
      total: 89.0,
      lines: [
        { desc: "Dedicated Root Server AX41-NVMe (Falkenstein)", qty: "1", unit: 39.0, amount: 39.0 },
        { desc: "Storage Box BX21 — 5 TB", qty: "1", unit: 11.9, amount: 11.9 },
        { desc: "Zusätzliche IPv4-Adresse", qty: "2", unit: 1.7, amount: 3.4 },
        { desc: "Traffic-Gebühren über Freikontingent", qty: "1", unit: 20.49, amount: 20.49 },
      ],
    }),
  },
  {
    id: "doc_f29",
    file: "scan_20250312_receipt.pdf",
    source: "upload",
    sourceDetail: "scanned to the shared folder by the office scanner",
    sourceRef: "upload-scan-20250312",
    /** Nothing to probe: the whole point is that there is no text to find. */
    probes: [],
    imageOnly: true,
    truth: {
      vendor: null, issueDate: null, total: null, currency: null,
      direction: "unknown", docType: "unknown", expectedCategoryId: "uncategorised",
      note: "No text layer at all. A correct extraction returns status unreadable and names what it could see. Guessing a vendor or a total from the filename is the failure this fixture tests for.",
    },
    expectedExceptions: ["unreadable-document", "unmatched-document"],
    build: () => scannedReceipt(),
  },
  {
    id: "doc_f30",
    file: "apple-store-invoice-w1882043.pdf",
    source: "gmail",
    sourceDetail: "from: no_reply@email.apple.com",
    sourceRef: "msg-18e7f3b09912",
    probes: ["Apple Store", "W1882043", "$2,899.00"],
    truth: {
      vendor: "Apple Inc.", issueDate: "2025-01-28", invoiceNumber: "W1882043",
      subtotal: 2899, tax: 0, total: 2899, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-depreciation",
      note: "Above the 2,500 capitalisation threshold and a durable item, so it is a depreciation question rather than an expense. The assistant routes it; it does not decide it.",
    },
    expectedExceptions: ["capitalisation-threshold", "category-needs-judgement"],
    build: () => supplierInvoice({
      vendor: "Apple Store",
      tagline: "Apple Inc. · Pioneer Place, Portland",
      vendorAddress: ["One Apple Park Way, Cupertino, CA 95014", "Apple Store Pioneer Place, 450 SW Yamhill St", "Portland, OR 97204"],
      accent: [0.14, 0.14, 0.16],
      title: "TAX INVOICE",
      number: "W1882043",
      issueDate: "2025-01-28",
      dueDate: "2025-01-28",
      terms: "Paid in full",
      reference: "Order W1882043",
      subtotal: 2899,
      tax: 0,
      taxLabel: "Sales tax (Oregon — none)",
      total: 2899,
      totalLabel: "TOTAL PAID (USD)",
      lines: [
        {
          desc: "MacBook Pro 16-inch, M4 Pro, 48GB, 1TB SSD",
          note: "Serial C02XN4471PQR · Space Black · AppleCare+ not purchased",
          qty: "1", unit: "$2,899.00", amount: 2899,
        },
      ],
      body: "Expected useful life is more than one year. Consult your tax adviser regarding capitalisation or a section 179 election.",
      footer: [
        "Apple Inc. — thank you for shopping at the Apple Store. Returns accepted within 14 days with this invoice.",
      ],
    }),
  },
  {
    id: "doc_f31",
    file: "verizon-wireless-feb-2025.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Utilities",
    sourceRef: "1jZ6uA-verizon-feb-2025",
    probes: ["verizon", "$128.77", "982441170-00001"],
    truth: {
      vendor: "Verizon Wireless", issueDate: "2025-02-14", invoiceNumber: "9824411700001",
      total: 128.77, currency: "USD", direction: "expense", docType: "invoice-received",
      expectedCategoryId: "expense-utilities",
      note: "A mixed-use line. Utilities always route to a human because the business-use fraction is a judgement no document states.",
    },
    expectedExceptions: ["category-needs-judgement"],
    build: () => wirelessBill({
      account: "982441170-00001",
      number: "9824411700001",
      issueDate: "2025-02-14",
      periodStart: "2025-01-14",
      periodEnd: "2025-02-13",
      dueDate: "2025-03-06",
      lines: [
        { number: "(503) 555-0142", user: "M. Whitfield", plan: "Unlimited Plus", amount: 55.0 },
        { number: "(503) 555-0177", user: "Studio line", plan: "Unlimited Welcome", amount: 40.0 },
        { number: "(503) 555-0193", user: "Hotspot — site work", plan: "Mobile hotspot 15GB", amount: 20.0 },
      ],
      extras: [
        ["Surcharges and fees", 9.42],
        ["Federal and state taxes", 4.35],
      ],
      total: 128.77,
      body: "One handset on this account is also used personally. Charges are not apportioned on this bill.",
    }),
  },
  {
    id: "doc_f32",
    file: "wholefoods-2025-02-27.pdf",
    source: "upload",
    sourceDetail: "photographed and uploaded by the office manager",
    sourceRef: "upload-wfm-0227",
    probes: ["WHOLE FOODS MARKET", "142.88"],
    truth: {
      vendor: "Whole Foods Market", issueDate: "2025-02-27", invoiceNumber: "WFM-0227",
      total: 142.88, subtotal: 142.88, tax: 0, currency: "USD",
      direction: "expense", docType: "receipt", expectedCategoryId: "non-deductible-personal",
      note: "Groceries on the business card. Recorded and set aside rather than deducted, and stated as a possibility for a person to confirm.",
    },
    expectedExceptions: ["possible-personal-expense", "category-needs-judgement"],
    build: () => tillReceipt({
      store: "WHOLE FOODS MARKET",
      storeAddress: ["PEARL DISTRICT", "1210 NW COUCH ST", "PORTLAND OR 97209", "(503) 555-0128"],
      issueDate: "2025-02-27",
      time: "18:04",
      storeNumber: "10269",
      txn: "WFM-0227",
      height: 620,
      items: [
        { desc: "365 ORG WHOLE MILK 2QT", amount: 7.98 },
        { desc: "ORG BANANAS 2.41 LB", amount: 3.61, note: "@ 1.4979/LB" },
        { desc: "PASTURE EGGS 12CT", amount: 8.49 },
        { desc: "SOURDOUGH BOULE", amount: 6.5 },
        { desc: "ORG BABY SPINACH 16OZ", amount: 7.99 },
        { desc: "WILD SOCKEYE FILLET", amount: 28.44 },
        { desc: "PARMIGIANO REGGIANO", amount: 18.72 },
        { desc: "ORG CHICKEN THIGHS", amount: 14.35 },
        { desc: "OLIVE OIL 750ML", amount: 19.99 },
        { desc: "DARK CHOCOLATE 85% x3", amount: 11.97 },
        { desc: "HOUSEHOLD CLEANER", amount: 6.49 },
        { desc: "PAPER TOWELS 6PK", amount: 8.35 },
      ],
      totals: [
        ["SUBTOTAL", "142.88"],
        ["OR TAX", "0.00"],
        ["TOTAL", "$142.88", true],
        ["VISA ****4471", "142.88"],
        ["AUTH 220914", ""],
      ],
      tail: ["PRIME MEMBER SAVINGS 6.42", "THANK YOU FOR SHOPPING", "WWW.WHOLEFOODSMARKET.COM"],
    }),
  },

  /* ── Contractors, health cover, mileage, and the date problems ────────── */
  {
    id: "doc_f33",
    file: "raman-consulting-invoice-0031.pdf",
    source: "gmail",
    sourceDetail: "from: priya@ramanconsulting.dev",
    sourceRef: "msg-18e9002b41c8",
    probes: ["Raman Consulting", "$4,500.00", "0031"],
    truth: {
      vendor: "Raman Consulting", issueDate: "2025-01-22", invoiceNumber: "0031",
      subtotal: 4500, tax: 0, total: 4500, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-contract-labor",
      vendorTaxId: null,
      note: "No tax identification number is printed anywhere on this invoice. A 1099-NEC needs one, so it has to be requested before filing.",
    },
    expectedExceptions: ["missing-vendor-tax-id", "contractor-1099-threshold"],
    build: () => supplierInvoice({
      vendor: "Raman Consulting",
      tagline: "Priya Raman — backend and data engineering",
      vendorAddress: ["4402 SE Hawthorne Boulevard, Apt 3", "Portland, OR 97215", "priya@ramanconsulting.dev"],
      accent: [0.3, 0.22, 0.45],
      number: "0031",
      issueDate: "2025-01-22",
      dueDate: "2025-02-05",
      terms: "Net 14",
      reference: "Atlas platform — data layer",
      hours: true,
      subtotal: 4500,
      tax: 0,
      taxLabel: "Sales tax",
      total: 4500,
      lines: [
        { desc: "Ingestion pipeline rebuild", note: "Weeks 2–3, January", qty: "36.0", unit: "$100.00", amount: 3600 },
        { desc: "Query performance review and indexing", qty: "9.0", unit: "$100.00", amount: 900 },
      ],
      body: "Independent contractor. Not an employee of Northwind Studio LLC. Payment by ACH to the account previously supplied.",
      footer: ["Thank you. Please reference invoice 0031 with payment."],
    }),
  },
  {
    id: "doc_f34",
    file: "raman-consulting-invoice-0034.pdf",
    source: "gmail",
    sourceDetail: "from: priya@ramanconsulting.dev",
    sourceRef: "msg-18f4b21c0d55",
    probes: ["Raman Consulting", "$3,200.00", "0034"],
    truth: {
      vendor: "Raman Consulting", issueDate: "2025-03-10", invoiceNumber: "0034",
      subtotal: 3200, tax: 0, total: 3200, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-contract-labor",
      vendorTaxId: "88-3320145",
      note: "With invoice 0031 the period total is 7,700.00, well over the 600.00 1099-NEC threshold.",
    },
    expectedExceptions: ["contractor-1099-threshold"],
    build: () => supplierInvoice({
      vendor: "Raman Consulting",
      tagline: "Priya Raman — backend and data engineering",
      vendorAddress: ["4402 SE Hawthorne Boulevard, Apt 3", "Portland, OR 97215", "priya@ramanconsulting.dev"],
      accent: [0.3, 0.22, 0.45],
      number: "0034",
      issueDate: "2025-03-10",
      dueDate: "2025-03-24",
      terms: "Net 14",
      vendorTaxId: "88-3320145",
      reference: "Atlas platform — reporting",
      hours: true,
      subtotal: 3200,
      tax: 0,
      taxLabel: "Sales tax",
      total: 3200,
      lines: [
        { desc: "Reporting warehouse schema", qty: "24.0", unit: "$100.00", amount: 2400 },
        { desc: "Scheduled export jobs and alerting", qty: "8.0", unit: "$100.00", amount: 800 },
      ],
      body: "Independent contractor. Tax identification number shown above, as requested for 1099 reporting.",
      footer: ["Thank you. Please reference invoice 0034 with payment."],
    }),
  },
  {
    id: "doc_f35",
    file: "t-alvarez-invoice-mar.pdf",
    source: "gmail",
    sourceDetail: "from: tom@alvarezmotion.com",
    sourceRef: "msg-18f6d09a11bb",
    probes: ["Alvarez Motion", "$520.00", "TA-MAR-2025"],
    truth: {
      vendor: "Alvarez Motion", issueDate: "2025-03-18", invoiceNumber: "TA-MAR-2025",
      subtotal: 520, tax: 0, total: 520, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-contract-labor",
      vendorTaxId: "84-1907733",
      note: "The negative case. Contract labour with a tax id on file and a period total of 520.00, below the 600.00 threshold — nothing should be raised against it.",
    },
    expectedExceptions: [],
    build: () => supplierInvoice({
      vendor: "Alvarez Motion",
      tagline: "Tom Alvarez — motion design",
      vendorAddress: ["1904 SE Division Street", "Portland, OR 97202", "tom@alvarezmotion.com"],
      accent: [0.16, 0.36, 0.32],
      number: "TA-MAR-2025",
      issueDate: "2025-03-18",
      dueDate: "2025-04-01",
      terms: "Net 14",
      vendorTaxId: "84-1907733",
      reference: "Cormorant brand launch",
      hours: true,
      subtotal: 520,
      tax: 0,
      taxLabel: "Sales tax",
      total: 520,
      lines: [
        { desc: "Logo animation — three variants", qty: "6.5", unit: "$80.00", amount: 520 },
      ],
      body: "Independent contractor. Tax identification number shown above.",
    }),
  },
  {
    id: "doc_f36",
    file: "meridian-health-premium-q1.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Insurance",
    sourceRef: "1eU1pV-meridian-q1-premium",
    probes: ["Meridian Health", "$1,842.00", "MH-Q1-2025"],
    truth: {
      vendor: "Meridian Health Plan", issueDate: "2025-01-05", invoiceNumber: "MH-Q1-2025",
      total: 1842, currency: "USD", direction: "expense", docType: "statement",
      expectedCategoryId: "non-deductible-health",
      note: "Self-employed health premiums are an adjustment to income on Schedule 1, not a Schedule C expense. Recorded so the figure is not lost, kept off the expense lines.",
    },
    expectedExceptions: ["category-needs-judgement"],
    build: () => insuranceSchedule({
      insurer: "Meridian Health Plan",
      insurerAddress: "Meridian Health Plan of Oregon, 900 SW 5th Avenue, Portland, OR 97204",
      accent: [0.12, 0.42, 0.44],
      title: "QUARTERLY PREMIUM STATEMENT",
      policy: "MH-Q1-2025",
      issueDate: "2025-01-05",
      coverFrom: "2025-01-01",
      coverTo: "2025-03-31",
      agent: "Direct — small business group",
      tableTitle: "Enrolled members and premium",
      coverages: [
        { name: "Member 001 — medical, Silver 2500", limit: "Individual", premium: 614 },
        { name: "Member 002 — medical, Silver 2500", limit: "Individual", premium: 614 },
        { name: "Member 003 — medical, Silver 2500", limit: "Individual", premium: 494 },
        { name: "Dental rider — all members", limit: "Individual", premium: 120 },
      ],
      total: 1842,
      totalLabel: "QUARTERLY PREMIUM (USD)",
      body: "Premiums are for health coverage. They are not a Schedule C business expense; treatment depends on the 1040 preparer.",
      footer: [
        "Meridian Health Plan of Oregon. This statement is not a policy document and confers no coverage of itself.",
        "Self-employed health insurance is deducted as an adjustment to income, subject to limits based on net profit.",
      ],
    }),
  },
  {
    id: "doc_f37",
    file: "mileage-log-q1-2025.pdf",
    source: "drive",
    sourceDetail: "Finance/2025/Q1/Vehicle",
    sourceRef: "1fV2qW-mileage-log-q1",
    probes: ["BUSINESS MILEAGE LOG", "1,240"],
    truth: {
      vendor: "Northwind Studio LLC", issueDate: "2025-03-31", invoiceNumber: null,
      total: null, currency: null, direction: "expense", docType: "mileage-log",
      expectedCategoryId: "expense-vehicle",
      note: "Carries no dollar figure at all. A correct extraction leaves total absent rather than deriving one from a mileage rate the document does not state.",
    },
    expectedExceptions: ["category-needs-judgement", "unmatched-document"],
    build: () => mileageLog({
      driver: "M. Whitfield",
      vehicle: "2019 Subaru Outback",
      odoStart: "84,112",
      odoEnd: "88,067",
      businessMiles: "1,240",
      personalMiles: "2,715",
      trips: [
        { date: "2025-01-09", from: "Kettle Row office", to: "Acme Robotics, Oakland", purpose: "Kick-off workshop", miles: 128 },
        { date: "2025-01-09", from: "Acme Robotics, Oakland", to: "Kettle Row office", purpose: "Return", miles: 128 },
        { date: "2025-01-23", from: "Kettle Row office", to: "Northgate Print, N Interstate", purpose: "Proof approval", miles: 11 },
        { date: "2025-02-04", from: "Kettle Row office", to: "Cormorant Ventures, Salem", purpose: "Brand presentation", miles: 96 },
        { date: "2025-02-04", from: "Cormorant Ventures, Salem", to: "Kettle Row office", purpose: "Return", miles: 96 },
        { date: "2025-02-11", from: "Kettle Row office", to: "Staples NW Couch", purpose: "Supplies collection", miles: 4 },
        { date: "2025-02-18", from: "Kettle Row office", to: "Ridgeline Coworking, Beaverton", purpose: "Client working session", miles: 22 },
        { date: "2025-02-20", from: "Kettle Row office", to: "Delta Freight, NE Alderwood", purpose: "Site walkthrough", miles: 19 },
        { date: "2025-03-06", from: "Kettle Row office", to: "Delta Freight, NE Alderwood", purpose: "Dashboard handover", miles: 19 },
        { date: "2025-03-12", from: "Kettle Row office", to: "Bluepeak Health, Vancouver WA", purpose: "Quarterly review", miles: 34 },
        { date: "2025-03-19", from: "Kettle Row office", to: "Harbor Legal, SW Broadway", purpose: "Contract signing", miles: 6 },
        { date: "2025-03-27", from: "Kettle Row office", to: "Bright Anvil Labs, Hillsboro", purpose: "Research sprint review", miles: 41 },
      ],
    }),
  },
  {
    id: "doc_f38",
    file: "koyo-studio-invoice-2024-1219.pdf",
    source: "gmail",
    sourceDetail: "from: hello@koyo.studio",
    sourceRef: "msg-18e2119c00ab",
    probes: ["Koyo Studio", "$1,650.00", "KS-2024-1219"],
    truth: {
      vendor: "Koyo Studio", issueDate: "2024-12-19", invoiceNumber: "KS-2024-1219",
      subtotal: 1650, tax: 0, total: 1650, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-contract-labor",
      vendorTaxId: "27-4418890",
      note: "Dated 19 December 2024, outside 2025 Q1, and it has no ledger row in this period. Flagged twice and excluded from the totals rather than pulled into the quarter.",
    },
    expectedExceptions: ["out-of-period", "unmatched-document"],
    build: () => supplierInvoice({
      vendor: "Koyo Studio",
      tagline: "Illustration and editorial art direction",
      vendorAddress: ["Unit 6, 88 Bathurst Street", "Toronto, ON M5V 2P8, Canada", "hello@koyo.studio"],
      accent: [0.55, 0.31, 0.12],
      number: "KS-2024-1219",
      issueDate: "2024-12-19",
      dueDate: "2025-01-02",
      terms: "Net 14",
      vendorTaxId: "27-4418890",
      reference: "Bluepeak care portal illustrations",
      subtotal: 1650,
      tax: 0,
      taxLabel: "Sales tax",
      total: 1650,
      lines: [
        { desc: "Spot illustrations — care journey set", note: "11 pieces, licensed for web and print", qty: "11", unit: "$120.00", amount: 1320 },
        { desc: "Revisions and file preparation", qty: "1", unit: "$330.00", amount: 330 },
      ],
      body: "Invoiced in USD. Work delivered December 2024.",
    }),
  },
  {
    id: "doc_f39",
    file: "bright-anvil-invoice-0442.pdf",
    source: "gmail",
    sourceDetail: "from: accounts@brightanvil.io",
    sourceRef: "msg-18f9c1a20d33",
    probes: ["Bright Anvil Labs", "$3,400.00", "0442"],
    truth: {
      vendor: "Bright Anvil Labs", issueDate: "2025-04-02", invoiceNumber: "0442",
      subtotal: 3400, tax: 0, total: 3400, currency: "USD",
      direction: "expense", docType: "invoice-received", expectedCategoryId: "expense-contract-labor",
      vendorTaxId: "46-3388120",
      note: "Issued 2 April 2025 for a ledger entry posted 27 March 2025. A document dated after the payment it supports is the one finding that goes to the tax manager immediately.",
    },
    expectedExceptions: ["backdated-document", "contractor-1099-threshold"],
    build: () => supplierInvoice({
      vendor: "Bright Anvil Labs",
      tagline: "Applied research sprints",
      vendorAddress: ["2400 NW 229th Avenue, Suite 110", "Hillsboro, OR 97124", "accounts@brightanvil.io"],
      accent: [0.24, 0.28, 0.55],
      number: "0442",
      issueDate: "2025-04-02",
      dueDate: "2025-04-16",
      terms: "Net 14",
      vendorTaxId: "46-3388120",
      reference: "Sprint 25-Q1-03",
      hours: true,
      subtotal: 3400,
      tax: 0,
      taxLabel: "Sales tax",
      total: 3400,
      lines: [
        { desc: "Research sprint — routing heuristics", note: "Sprint ran 17–27 March 2025", qty: "34.0", unit: "$100.00", amount: 3400 },
      ],
      body: "Invoice raised after sprint close. Payment was made on account in advance of invoicing.",
      footer: ["Bright Anvil Labs — please reference 0442 with payment."],
    }),
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * The ledger
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * `fixtures/ledger-2025-q1.csv` — the accounting system's version of the
 * quarter.
 *
 * The divergences are the point. Reconciliation exists to find the four kinds
 * of disagreement a person cannot spot by eye across thirty-nine documents:
 *
 *   1. AWS January — the ledger says 1,824.19 and the invoice says 1,842.19.
 *      A transposition of the same two digits, an $18.00 delta, and the single
 *      finding this whole module exists for.
 *   2. AWS March — a ledger row with no document at all. Missing support, and
 *      because AWS billed January and February, a gap in a monthly cadence.
 *   3. Ridgeline Coworking and Notion Labs — ledger rows nobody kept a receipt
 *      for.
 *   4. Bright Anvil — posted 27 March, invoiced 2 April.
 *
 * A few fields carry commas and one carries doubled quotes, deliberately: the
 * CSV parser in `src/lib/ledger.ts` is hand-written, and a corpus of clean
 * fields would never exercise it.
 */
const LEDGER = [
  ["2025-01-01", "WeWork dedicated desks — January", "WeWork", 1400.0, "USD", "Rent and occupancy", "WW-2025-0101"],
  ["2025-01-02", "Google Workspace Business Standard, 12 seats", "Google LLC", 180.0, "USD", "Software and hosting", "GW-JAN-2025"],
  ["2025-01-03", "Amazon Web Services, Inc. — December usage", "AWS", 1824.19, "USD", "Software and hosting", "INV-AWS-JAN25"],
  ["2025-01-05", "Meridian Health Plan — Q1 premium", "Meridian Health Plan", 1842.0, "USD", "Health insurance", "MH-Q1-2025"],
  ["2025-01-08", "Invoice INV-2025-001 — Atlas platform design", "Acme Robotics Inc.", 12500.0, "USD", "Sales — services", "INV-2025-001"],
  ["2025-01-11", "Figma organisation seats, annual", "Figma, Inc.", 1080.0, "USD", "Software and hosting", "FIG-2025-4471"],
  ["2025-01-15", "Invoice INV-2025-002 — care portal retainer", "Bluepeak Health Systems", 8400.0, "USD", "Sales — services", "INV-2025-002"],
  ["2025-01-20", "State Farm business liability, annual premium", "State Farm", 1260.0, "USD", "Insurance", "97-BL-4471-08"],
  ["2025-01-22", "Raman Consulting — data layer, invoice 0031", "Raman Consulting", 4500.0, "USD", "Contract labour", "0031"],
  ["2025-01-28", "MacBook Pro 16-inch, order W1882043", "Apple Inc.", 2899.0, "USD", "Equipment", "W1882043"],
  ["2025-02-01", "WeWork dedicated desks — February", "WeWork", 1400.0, "USD", "Rent and occupancy", "WW-2025-0201"],
  ["2025-02-02", "Google Workspace Business Standard, 12 seats", "Google LLC", 180.0, "USD", "Software and hosting", "GW-FEB-2025"],
  ["2025-02-03", "Amazon Web Services, Inc. — January usage", "AWS", 2014.55, "USD", "Software and hosting", "INV-AWS-FEB25"],
  ["2025-02-04", "Invoice INV-2025-003 — brand system", "Cormorant Ventures LP", 15000.0, "USD", "Sales — services", "INV-2025-003"],
  ["2025-02-06", "Adobe Creative Cloud, All Apps team licence", "Adobe Inc.", 59.99, "USD", "Software and hosting", "ADB-88214"],
  ["2025-02-08", "Invoice INV-2025-004 — Atlas retainer", "Acme Robotics Inc.", 12500.0, "USD", "Sales — services", "INV-2025-004"],
  ["2025-02-11", "Staples — paper, ink, filing", "Staples", 87.43, "USD", "Office supplies", "4471-0092"],
  ["2025-02-14", "Verizon Wireless — three lines, mixed use", "Verizon Wireless", 128.77, "USD", "Telephone and internet", "9824411700001"],
  ["2025-02-15", "Invoice INV-2025-005 — care portal retainer", "Bluepeak Health Systems", 8400.0, "USD", "Sales — services", "INV-2025-005"],
  ["2025-02-18", 'Day pass, booked as "team offsite"', "Ridgeline Coworking", 45.0, "USD", "Rent and occupancy", "RC-DP-0218"],
  ["2025-02-19", "Harbor Legal LLP — MSA review, matter 2025-0114", "Harbor Legal LLP", 950.0, "USD", "Legal and professional", "2291"],
  ["2025-02-21", "Northgate Print Works — brochures, cards, banner", "Northgate Print Works", 927.0, "USD", "Advertising and marketing", "4471"],
  ["2025-02-27", "Whole Foods Market, Pearl District", "Whole Foods Market", 142.88, "USD", "Uncategorised — to review", "WFM-0227"],
  ["2025-02-28", "Stripe processing fees, February payout", "Stripe", 611.2, "USD", "Merchant and bank fees", "po_1QxNwFeb25"],
  ["2025-03-01", "WeWork dedicated desks — March", "WeWork", 1400.0, "USD", "Rent and occupancy", "WW-2025-0301"],
  ["2025-03-02", "Google Workspace Business Standard, 12 seats", "Google LLC", 180.0, "USD", "Software and hosting", "GW-MAR-2025"],
  ["2025-03-03", "Amazon Web Services, Inc. — February usage", "AWS", 2190.44, "USD", "Software and hosting", "INV-AWS-MAR25"],
  ["2025-03-03", "Delta Air Lines — PDX/SFO/PDX, M. Whitfield", "Delta Air Lines", 612.4, "USD", "Travel", "0062418833901"],
  ["2025-03-04", "Cascade Kitchen — client lunch, 4 covers", "Cascade Kitchen", 214.6, "USD", "Meals and entertainment", "CK-0318"],
  ["2025-03-05", "Hyatt Regency San Francisco — 2 nights", "Hyatt Regency", 884.0, "USD", "Travel", "884213"],
  ["2025-03-05", "Hetzner Online GmbH — server hosting, February", "Hetzner Online GmbH", 89.0, "USD", "Software and hosting", "R0025883149"],
  ["2025-03-06", "Invoice INV-2025-006 — logistics dashboard", "Delta Freight Co.", 6750.0, "USD", "Sales — services", "INV-2025-006"],
  ["2025-03-10", "Raman Consulting — reporting, invoice 0034", "Raman Consulting", 3200.0, "USD", "Contract labour", "0034"],
  ["2025-03-15", "Invoice INV-2025-007 — care portal retainer", "Bluepeak Health Systems", 8400.0, "USD", "Sales — services", "INV-2025-007"],
  ["2025-03-18", "Alvarez Motion — logo animation", "Alvarez Motion", 520.0, "USD", "Contract labour", "TA-MAR-2025"],
  ["2025-03-21", "Notion Labs — team subscription, March", "Notion Labs", 96.0, "USD", "Software and hosting", "NL-2025-03"],
  ["2025-03-24", "Credit note CN-2025-001 — scope reduction", "Delta Freight Co.", -750.0, "USD", "Sales returns and allowances", "CN-2025-001"],
  ["2025-03-27", "Bright Anvil Labs — research sprint 25-Q1-03", "Bright Anvil Labs", 3400.0, "USD", "Contract labour", "0442"],
];

const LEDGER_HEADER = ["date", "description", "counterparty", "amount", "currency", "account", "ref"];

/**
 * RFC 4180 quoting, by hand.
 *
 * A field is quoted when it holds a comma, a quote, or a newline, and an
 * embedded quote is doubled. Writing this out rather than reaching for a
 * library keeps the corpus honest about what the importer has to survive.
 */
function csvField(value) {
  const text = typeof value === "number" ? value.toFixed(2) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderLedger() {
  const rows = [LEDGER_HEADER.join(",")];
  for (const row of LEDGER) rows.push(row.map(csvField).join(","));
  return `${rows.join("\r\n")}\r\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Findings the corpus expects, and the ones it cannot promise
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The distinct findings the corpus should produce.
 *
 * Separate from each document's `expectedExceptions`, and deliberately so.
 * A document's list answers "what flags will be attached to this file", which
 * is what the documents tab shows; this list answers "how many exceptions are
 * on the register", which is what the counts on the overview must agree with.
 * They are not the same number: one duplicate finding names two files, and one
 * 1099 threshold finding names every invoice from that contractor. Deriving
 * the counts from the per-document lists would double them and make a correct
 * run look like a regression.
 */
const EXPECTED_FINDINGS = [
  {
    kind: "duplicate-document", severity: "high", docIds: ["doc_f25", "doc_f26"],
    detail: "Adobe ADB-88214 arrived twice, byte for byte. adobe-cc-feb-2025.pdf and Adobe_Invoice_ADB-88214 (1).pdf share a sha256.",
  },
  {
    kind: "total-mismatch", severity: "high", docIds: ["doc_f27"],
    detail: "Northgate Print 4471 prints 900.00 + 72.00 = 927.00. The arithmetic gives 972.00; the last two digits are transposed.",
  },
  {
    kind: "ledger-amount-mismatch", severity: "high", docIds: ["doc_f10"], ledgerRefs: ["INV-AWS-JAN25"],
    detail: "AWS January: the invoice says 1,842.19 and the ledger says 1,824.19. An 18.00 delta on the same two digits.",
  },
  {
    kind: "missing-support", severity: "high", docIds: [], ledgerRefs: ["INV-AWS-MAR25"],
    detail: "The March AWS charge of 2,190.44 is on the ledger with no invoice behind it.",
  },
  {
    kind: "missing-support", severity: "high", docIds: [], ledgerRefs: ["RC-DP-0218"],
    detail: "Ridgeline Coworking day pass, 45.00, no receipt collected.",
  },
  {
    kind: "missing-support", severity: "high", docIds: [], ledgerRefs: ["NL-2025-03"],
    detail: "Notion Labs subscription, 96.00, no receipt collected.",
  },
  {
    kind: "missing-period", severity: "medium", docIds: ["doc_f10", "doc_f11"], ledgerRefs: ["INV-AWS-MAR25"],
    detail: "AWS billed January and February. March has a ledger row and no document, breaking a monthly cadence inside the period.",
  },
  {
    kind: "unmatched-document", severity: "medium", docIds: ["doc_f26"],
    detail: "The second Adobe copy pairs with nothing: the single ledger row is already taken by the first.",
  },
  {
    kind: "unmatched-document", severity: "medium", docIds: ["doc_f29"],
    detail: "scan_20250312_receipt.pdf has no figures to match on and no ledger row that fits it.",
  },
  {
    kind: "unmatched-document", severity: "medium", docIds: ["doc_f37"],
    detail: "The mileage log states no amount, so there is nothing for a cash-basis ledger row to pair with.",
  },
  {
    kind: "unmatched-document", severity: "medium", docIds: ["doc_f38"],
    detail: "Koyo Studio KS-2024-1219 has no ledger row in this period; it belongs to the quarter before.",
  },
  {
    kind: "unreadable-document", severity: "high", docIds: ["doc_f29"],
    detail: "scan_20250312_receipt.pdf carries no text layer. Nothing can be read off it, and nothing should be guessed from its filename.",
  },
  {
    kind: "out-of-period", severity: "medium", docIds: ["doc_f38"],
    detail: "Koyo Studio KS-2024-1219 is dated 2024-12-19, outside 2025-01-01 to 2025-03-31.",
  },
  {
    kind: "currency-mismatch", severity: "high", docIds: ["doc_f28"],
    detail: "Hetzner R0025883149 totals 89.00 EUR against a USD period. No rate is stated on the document, so it is flagged rather than converted.",
  },
  {
    kind: "category-needs-judgement", severity: "medium", docIds: ["doc_f30"],
    detail: "A MacBook Pro is a depreciation question, not an office expense. Capitalise, de minimis, or section 179 is a person's call.",
  },
  {
    kind: "category-needs-judgement", severity: "medium", docIds: ["doc_f31"],
    detail: "Verizon: three lines, one of them also used personally. The business-use fraction is not on the bill.",
  },
  {
    kind: "category-needs-judgement", severity: "medium", docIds: ["doc_f32"],
    detail: "Whole Foods on the business card. Calling a purchase personal removes a deduction, so a human confirms it.",
  },
  {
    kind: "category-needs-judgement", severity: "medium", docIds: ["doc_f36"],
    detail: "Health premiums are an adjustment to income on Schedule 1, not a Schedule C line. It belongs to the 1040 preparer.",
  },
  {
    kind: "category-needs-judgement", severity: "medium", docIds: ["doc_f37"],
    detail: "Standard mileage or actual vehicle costs give different figures and cannot be mixed. The method is chosen, not derived.",
  },
  {
    kind: "missing-vendor-tax-id", severity: "low", docIds: ["doc_f33"],
    detail: "Raman Consulting invoice 0031 prints no tax identification number, and a 1099-NEC needs one.",
  },
  {
    kind: "possible-personal-expense", severity: "medium", docIds: ["doc_f32"],
    detail: "Whole Foods Market, 142.88 of groceries on the business card.",
  },
  {
    kind: "capitalisation-threshold", severity: "medium", docIds: ["doc_f30"],
    detail: "MacBook Pro at 2,899.00 is above the 2,500.00 capitalisation threshold and has a useful life over a year.",
  },
  {
    kind: "contractor-1099-threshold", severity: "medium", docIds: ["doc_f33", "doc_f34"],
    detail: "Raman Consulting totals 7,700.00 in the period, over the 600.00 1099-NEC threshold. Invoice 0031 has no tax id on it.",
  },
  {
    kind: "contractor-1099-threshold", severity: "medium", docIds: ["doc_f39"],
    detail: "Bright Anvil Labs totals 3,400.00 in the period, over the 600.00 threshold.",
  },
  {
    kind: "backdated-document", severity: "high", docIds: ["doc_f39"], ledgerRefs: ["0442"],
    detail: "Bright Anvil 0442 is dated 2025-04-02 against a ledger entry posted 2025-03-27, and after the period end. Escalate to the tax manager immediately.",
  },
];

/**
 * The negative cases, written down so nobody "fixes" them into findings.
 *
 * A corpus that only contains defects trains the reader to expect one on every
 * page. These are the documents that must come through clean.
 */
const EXPECTED_CLEAN = [
  { docId: "doc_f35", why: "Contract labour, tax id printed, 520.00 in the period — below the 600.00 threshold. Nothing should be raised." },
  { docId: "doc_f24", why: "Business meals at 50%. The haircut is an adjustment on the form line, not an exception." },
  { docId: "doc_f08", why: "A credit note is negative revenue, not an error. It belongs on Schedule C line 2." },
  { docId: "doc_f09", why: "A payout report carries three figures. Only the 611.20 of fees is an expense; the gross is revenue already invoiced." },
];

/**
 * Findings that depend on a model's own confidence, not on a printed fact.
 *
 * `low-confidence-category` is reachable — the unreadable scan and the mileage
 * log both give a classifier very little to go on — but whether it fires
 * depends on a number the model chooses. Asserting on it would make the smoke
 * test fail for a reading that was not wrong, so it is recorded here as
 * expected-but-not-asserted rather than counted above.
 */
const MODEL_DEPENDENT = {
  "low-confidence-category": {
    likelyDocIds: ["doc_f29", "doc_f37"],
    why:
      "An image-only scan and a mileage log with no vendor, no total and no invoice number are the two " +
      "documents a classifier has least to work with. Whether confidence lands below reviewConfidence " +
      "is the model's call, so this is reported as drift rather than asserted.",
  },
  "category-needs-judgement (doc_f29)": {
    likelyDocIds: ["doc_f29"],
    why:
      "An unreadable scan most plausibly lands in `uncategorised`, which carries alwaysReview and would " +
      "add a sixth category-needs-judgement. It is not counted above because which category a model " +
      "picks for a page it could not read is not a printed fact.",
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * Build, verify, report
 * ────────────────────────────────────────────────────────────────────────── */

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Checks that run on every generated file, every time.
 *
 * These are cheap and they catch the failures that would otherwise surface
 * three modules downstream as "the model could not read it": a truncated file,
 * a stream that lost its text, a sketch page that somehow acquired a glyph.
 */
function verify(entry, bytes) {
  const problems = [];
  const text = bytes.toString("latin1");

  if (!text.startsWith("%PDF-")) problems.push("does not start with %PDF-");
  if (!text.trimEnd().endsWith("%%EOF")) problems.push("does not end with %%EOF");
  if (!/\nstartxref\n\d+\n/.test(text)) problems.push("has no startxref offset");

  const hasText = /\bTj\b|\bTJ\b/.test(text);
  if (entry.imageOnly) {
    // The single most important assertion in this file. If this ever passes
    // wrongly, the unreadable-document path is being exercised by a document
    // that is perfectly readable.
    if (hasText) problems.push("is the image-only fixture but carries a Tj/TJ text operator");
  } else if (!hasText) {
    problems.push("carries no text operators at all");
  }

  for (const probe of entry.probes ?? []) {
    if (!text.includes(probe)) problems.push(`does not contain the expected string ${JSON.stringify(probe)}`);
  }
  return problems;
}

async function main() {
  await rm(DOCS_OUT, { recursive: true, force: true });
  await mkdir(DOCS_OUT, { recursive: true });

  const rendered = new Map();
  const manifestDocuments = [];
  const problems = [];

  for (const entry of DOCUMENTS) {
    const bytes = entry.copyOf
      ? rendered.get(entry.copyOf)
      : entry.build().toBuffer();

    if (!bytes) {
      throw new Error(`${entry.id} copies ${entry.copyOf}, which has not been rendered yet.`);
    }
    rendered.set(entry.id, bytes);
    await writeFile(path.join(DOCS_OUT, entry.file), bytes);

    for (const problem of verify(entry, bytes)) {
      problems.push(`${entry.file} ${problem}`);
    }

    manifestDocuments.push({
      id: entry.id,
      file: entry.file,
      source: entry.source,
      sourceDetail: entry.sourceDetail,
      sourceRef: entry.sourceRef,
      mimeType: "application/pdf",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      imageOnly: Boolean(entry.imageOnly),
      copyOf: entry.copyOf,
      truth: entry.truth,
      expectedExceptions: entry.expectedExceptions,
    });
  }

  /* The duplicate has to actually be a duplicate. */
  const adobe = manifestDocuments.filter((d) => d.id === "doc_f25" || d.id === "doc_f26");
  if (adobe.length === 2 && adobe[0].sha256 !== adobe[1].sha256) {
    problems.push("doc_f25 and doc_f26 are meant to be byte-identical but their hashes differ");
  }

  /* The ledger. */
  const csv = renderLedger();
  await writeFile(path.join(OUT, "ledger-2025-q1.csv"), csv, "utf8");

  const csvLines = csv.split("\r\n").filter((line) => line.length > 0);
  for (const [i, line] of csvLines.entries()) {
    // Count only the commas that sit outside quotes; a description holding a
    // comma is legitimate and must not be reported as a malformed row.
    let quoted = false;
    let fields = 1;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) fields += 1;
    }
    if (fields !== LEDGER_HEADER.length) {
      problems.push(`ledger-2025-q1.csv line ${i + 1} has ${fields} fields, expected ${LEDGER_HEADER.length}`);
    }
  }

  /* The manifest. */
  const expectedExceptionCounts = {};
  const KINDS = [
    "duplicate-document", "total-mismatch", "ledger-amount-mismatch", "missing-support",
    "unmatched-document", "unreadable-document", "missing-period", "out-of-period",
    "currency-mismatch", "low-confidence-category", "category-needs-judgement",
    "missing-vendor-tax-id", "possible-personal-expense", "capitalisation-threshold",
    "contractor-1099-threshold", "backdated-document",
  ];
  for (const kind of KINDS) expectedExceptionCounts[kind] = 0;
  for (const finding of EXPECTED_FINDINGS) expectedExceptionCounts[finding.kind] += 1;

  /**
   * Every kind must be reachable from this corpus, or a rule in
   * `exceptions.ts` ships with nothing exercising it. The one permitted
   * absence is the kind that turns on a model's confidence rather than on a
   * printed fact, and it is listed under `modelDependentExceptions` instead.
   */
  for (const kind of KINDS) {
    if (expectedExceptionCounts[kind] === 0 && !MODEL_DEPENDENT[kind]) {
      problems.push(`no fixture raises ${kind}; that exception kind is untested`);
    }
  }

  /* A kind on a document's list that no finding accounts for means the two
     halves of the manifest disagree about what the corpus does. */
  const findingKinds = new Set(EXPECTED_FINDINGS.map((finding) => finding.kind));
  for (const doc of manifestDocuments) {
    for (const kind of doc.expectedExceptions) {
      if (!findingKinds.has(kind)) {
        problems.push(`${doc.file} expects ${kind}, which is in no entry of EXPECTED_FINDINGS`);
      }
    }
  }

  const manifest = {
    generatedBy: "scripts/generate-fixtures.mjs",
    entity: ENTITY.name,
    entityTaxId: ENTITY.ein,
    period: {
      id: PERIOD.id,
      label: PERIOD.label,
      start: PERIOD.start,
      end: PERIOD.end,
      currency: PERIOD.currency,
    },
    documentCount: manifestDocuments.length,
    documents: manifestDocuments,
    ledgerFile: "ledger-2025-q1.csv",
    ledgerRowCount: LEDGER.length,
    ledgerColumns: LEDGER_HEADER,
    expectedFindings: EXPECTED_FINDINGS,
    expectedClean: EXPECTED_CLEAN,
    expectedExceptionCounts,
    modelDependentExceptions: MODEL_DEPENDENT,
    notes: [
      "truth is what a correct extraction returns, not an assertion. Compare numerically, and compare dates and vendor names case-insensitively; a model that reads 1,842.19 as 1842.19 has not made a mistake.",
      "expectedFindings is the count the register should hold; a document's expectedExceptions is the list of flags attached to that file. They differ because one finding can name two documents, so do not sum the per-document lists.",
      "aws-invoice-mar-2025 is deliberately absent. The ledger carries the March AWS charge and no document supports it.",
      "doc_f25 and doc_f26 are byte-identical on purpose. The '(1)' in the second filename is the only human-visible tell.",
      "doc_f29 has no text layer at all. Any extraction that returns a vendor or a total for it has invented one.",
      "Nothing in this corpus has been filed, and no figure in it is advice.",
    ],
  };
  await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  /* Files on disk must match the manifest, or the seeder loads a corpus that
     is not the one the smoke test asserts against. */
  const onDisk = (await readdir(DOCS_OUT)).filter((name) => name.endsWith(".pdf"));
  if (onDisk.length !== manifestDocuments.length) {
    problems.push(
      `manifest lists ${manifestDocuments.length} documents but ${onDisk.length} PDFs are on disk`,
    );
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  const bySource = {};
  for (const doc of manifestDocuments) bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;

  console.log(`Wrote ${manifestDocuments.length} PDFs to fixtures/documents.`);
  console.log(`Wrote ${LEDGER.length} ledger rows to fixtures/ledger-2025-q1.csv.`);
  console.log(`Wrote fixtures/manifest.json.`);
  console.log(
    `Sources: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
  );
  console.log(`Expected findings on the register: ${EXPECTED_FINDINGS.length}.`);
  console.log("\nExpected exceptions by kind:");
  for (const [kind, count] of Object.entries(expectedExceptionCounts)) {
    const suffix = count === 0 && MODEL_DEPENDENT[kind] ? "  (model-dependent, not asserted)" : "";
    console.log(`  ${kind.padEnd(28)} ${count}${suffix}`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} verification problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nVerified: every file starts %PDF- and ends %%EOF, every xref offset is present,");
  console.log("scan_20250312_receipt.pdf carries no Tj/TJ operator, every other file's text is");
  console.log("greppable in its uncompressed stream, and the ledger has 7 fields on every row.");
  console.log("\nNext: npm run seed");
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
