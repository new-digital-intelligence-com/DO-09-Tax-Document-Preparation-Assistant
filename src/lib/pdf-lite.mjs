/**
 * A minimal PDF 1.4 writer, from scratch, with no dependencies.
 *
 * The corpus has to be *real* PDFs — the extraction step hands them to the
 * model as `document` content blocks, and the console embeds them in an
 * iframe. A fake that only our own code can read would make the whole pipeline
 * pass on files no reviewer could ever open, which is the failure this module
 * exists to prevent. So: a correct `xref` table, a correct `startxref` offset,
 * and base-14 fonts a viewer already has.
 *
 * Two deliberate non-features.
 *
 *   Content streams are **uncompressed**. A compressed stream is unreadable to
 *   `grep`, and the generator's own verification pass is a byte search for the
 *   text it claims to have written. A fixture whose contents cannot be checked
 *   without a PDF library is a fixture nobody checks.
 *
 *   There is **no layout engine**. Coordinates are given, not computed; text
 *   does not wrap and columns do not balance. Every fixture in this corpus is
 *   hand-placed, and a page that overflows is a bug in the caller, not
 *   something this module silently reflows.
 *
 * Coordinates are top-left origin, in points, because that is how a person
 * describes an invoice ("the total sits 40pt below the table"). PDF's own
 * origin is bottom-left; the flip happens once, here, rather than in every
 * caller.
 *
 * Output is byte-deterministic: no timestamp, no random id. Re-running the
 * generator must reproduce the same sha256 for every file, or the duplicate
 * fixture stops being a duplicate and the corpus stops being a test.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* ────────────────────────────────────────────────────────────────────────────
 * Encoding
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * WinAnsi code points that are not Latin-1.
 *
 * The Hetzner fixture is the reason this table exists: its total is printed in
 * euros, and `€` is 0x80 in WinAnsiEncoding while being U+20AC in JavaScript.
 * Writing the raw code point would emit a byte the viewer renders as something
 * else entirely, and a currency-mismatch fixture that does not show a currency
 * symbol tests nothing. The umlauts it also needs (`ü`, `ö`, `ä`, `ß`) are
 * already Latin-1 and pass straight through.
 */
const WINANSI = new Map(
  Object.entries({
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84,
    "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
    "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
    "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
    "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
    "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
    "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  }),
);

/**
 * One string, escaped and encoded, ready to sit inside `( … )`.
 *
 * An unescaped `)` in a vendor name closes the string operand early and every
 * byte after it is read as an operator — the page then renders as garbage or
 * not at all, and the failure is silent until someone opens the file. A
 * character with no WinAnsi byte becomes `?` rather than being dropped, so the
 * loss is visible on the page instead of only in the byte count.
 */
function pdfText(value) {
  const out = [];
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    const byte = cp <= 0xff ? cp : (WINANSI.get(ch) ?? 0x3f);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c);
    out.push(byte);
  }
  return Buffer.from(out).toString("latin1");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Metrics
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Adobe's published widths for the base-14 faces, ASCII 32–126, in 1/1000 em.
 *
 * Only enough to right-align a money column. Every invoice in the world puts
 * its totals flush right, and a corpus whose amounts drift a few points off
 * the column reads as generated rather than collected — which is exactly the
 * tell a reviewer would notice first. Characters outside this range fall back
 * to a middling width; the only ones in the corpus are the euro sign and the
 * German umlauts, and being a point or two out on those costs nothing.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Courier is monospaced by definition; one number covers every glyph. */
const COURIER_WIDTH = 600;

const FONTS = {
  Helvetica: { resource: "F1", widths: HELVETICA },
  "Helvetica-Bold": { resource: "F2", widths: HELVETICA_BOLD },
  Courier: { resource: "F3", widths: null },
};

/** Aliases, so a caller can say `bold` or `mono` without remembering PostScript names. */
const ALIASES = { bold: "Helvetica-Bold", regular: "Helvetica", mono: "Courier", courier: "Courier" };

function fontOf(name) {
  const key = ALIASES[name] ?? name ?? "Helvetica";
  const font = FONTS[key];
  if (!font) {
    throw new Error(
      `Unknown font "${name}". This writer embeds nothing: the choices are ` +
        `Helvetica, Helvetica-Bold and Courier.`,
    );
  }
  return font;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Formatting helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Numbers in a content stream, trimmed.
 *
 * Two decimals is finer than any viewer resolves at these sizes, and trailing
 * zeros in a stream that is meant to be greppable are noise. `-0` becomes `0`
 * because a leading minus on a zero coordinate reads as a bug when someone
 * opens the stream to check it.
 */
function num(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function colour(value) {
  const [r, g, b] = value ?? [0, 0, 0];
  return `${num(r)} ${num(g)} ${num(b)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The document
 * ────────────────────────────────────────────────────────────────────────── */

export class Pdf {
  /** US Letter by default; the till-roll receipts pass their own narrow size. */
  constructor({
    width = 612,
    height = 792,
    producer = "DO-09 fixture generator, src/lib/pdf-lite.mjs",
    creator = "DO-09 Tax Document Preparation Assistant",
    creationDate = "D:20250401120000Z",
  } = {}) {
    this.defaultSize = { width, height };
    this.producer = producer;
    this.creator = creator;
    this.creationDate = creationDate;
    this.pages = [];
    this.current = null;
  }

  /** `D:YYYYMMDDHHmmSSZ`, the only date syntax a PDF reader accepts. */
  static stamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
      `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
    );
  }

  /** Start a new page. Everything drawn afterwards lands on it. */
  page({ width, height } = {}) {
    this.current = {
      width: width ?? this.defaultSize.width,
      height: height ?? this.defaultSize.height,
      ops: [],
    };
    this.pages.push(this.current);
    return this;
  }

  #need() {
    if (!this.current) {
      throw new Error("Nothing to draw on. Call page() before the first text() or rect().");
    }
    return this.current;
  }

  /** Flip a top-left y into PDF's bottom-left space. */
  #y(y) {
    return this.#need().height - y;
  }

  /** How wide a string sets, in points. Used to right-align and centre. */
  widthOf(value, { font = "Helvetica", size = 10 } = {}) {
    const { widths } = fontOf(font);
    let total = 0;
    for (const ch of String(value)) {
      const cp = ch.codePointAt(0);
      if (!widths) {
        total += COURIER_WIDTH;
      } else if (cp >= 32 && cp <= 126) {
        total += widths[cp - 32];
      } else {
        total += 556;
      }
    }
    return (total / 1000) * size;
  }

  /**
   * One run of text, its left edge at `x` and its baseline at `y`.
   *
   * Baseline rather than top edge, because that is what lines up two runs at
   * different sizes on the same row — a vendor name in 16pt bold beside a date
   * in 9pt regular is the commonest row in the corpus.
   */
  text(x, y, value, { font = "Helvetica", size = 10, color = [0, 0, 0], charSpace = 0 } = {}) {
    const page = this.#need();
    const { resource } = fontOf(font);
    const spacing = charSpace ? `${num(charSpace)} Tc ` : "";
    page.ops.push(
      `BT ${spacing}/${resource} ${num(size)} Tf ${colour(color)} rg ` +
        `${num(x)} ${num(this.#y(y))} Td (${pdfText(value)}) Tj ET` +
        (charSpace ? " BT 0 Tc ET" : ""),
    );
    return this;
  }

  /** Text whose *right* edge sits at `x`. Every money column in the corpus uses it. */
  textRight(x, y, value, opts = {}) {
    return this.text(x - this.widthOf(value, opts), y, value, opts);
  }

  /** Text centred on `x`. Receipt headers and the sketch fixture's stamp. */
  textCentre(x, y, value, opts = {}) {
    return this.text(x - this.widthOf(value, opts) / 2, y, value, opts);
  }

  line(x1, y1, x2, y2, { color = [0, 0, 0], lineWidth = 0.6 } = {}) {
    const page = this.#need();
    page.ops.push(
      `${num(lineWidth)} w ${colour(color)} RG ` +
        `${num(x1)} ${num(this.#y(y1))} m ${num(x2)} ${num(this.#y(y2))} l S`,
    );
    return this;
  }

  /**
   * A rectangle, filled, stroked, or both.
   *
   * `fill` first then `stroke`, so a boxed total shows its rule over its tint
   * rather than under it.
   */
  rect(x, y, w, h, { fill, stroke, lineWidth = 0.6 } = {}) {
    const page = this.#need();
    const box = `${num(x)} ${num(this.#y(y + h))} ${num(w)} ${num(h)} re`;
    if (fill && stroke) {
      page.ops.push(`${colour(fill)} rg ${colour(stroke)} RG ${num(lineWidth)} w ${box} B`);
    } else if (fill) {
      page.ops.push(`${colour(fill)} rg ${box} f`);
    } else if (stroke) {
      page.ops.push(`${colour(stroke)} RG ${num(lineWidth)} w ${box} S`);
    }
    return this;
  }

  /**
   * Freehand strokes — path operators and nothing else.
   *
   * This is the whole mechanism behind the image-only fixture. A scan of a
   * crumpled handwritten receipt carries no text operators at all, and the
   * pipeline has to treat that as `unreadable` rather than quietly extracting
   * a total from the filename. If this method ever emitted a `Tj`, that
   * fixture would start passing for the wrong reason, so it emits `m`, `l`,
   * `c` and `S` and no glyph operator can reach the stream through it.
   *
   * `curve` runs a Catmull-Rom spline through the points, which is what makes
   * a polyline read as handwriting rather than as a chart.
   */
  sketch(strokes, { color = [0.25, 0.25, 0.28], lineWidth = 1 } = {}) {
    const page = this.#need();
    for (const raw of strokes) {
      const stroke = Array.isArray(raw) ? { points: raw } : raw;
      const points = stroke.points ?? [];
      if (points.length < 2) continue;

      const width = stroke.lineWidth ?? lineWidth;
      const tint = stroke.color ?? color;
      const px = points.map(([x, y]) => [x, this.#y(y)]);
      const parts = [`${num(width)} w 1 J 1 j ${colour(tint)} RG`, `${num(px[0][0])} ${num(px[0][1])} m`];

      if (stroke.curve) {
        for (let i = 0; i < px.length - 1; i += 1) {
          const p0 = px[Math.max(0, i - 1)];
          const p1 = px[i];
          const p2 = px[i + 1];
          const p3 = px[Math.min(px.length - 1, i + 2)];
          const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
          const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
          parts.push(
            `${num(c1[0])} ${num(c1[1])} ${num(c2[0])} ${num(c2[1])} ${num(p2[0])} ${num(p2[1])} c`,
          );
        }
      } else {
        for (let i = 1; i < px.length; i += 1) parts.push(`${num(px[i][0])} ${num(px[i][1])} l`);
      }

      if (stroke.close) parts.push("h");
      parts.push("S");
      page.ops.push(parts.join(" "));
    }
    return this;
  }

  /* ── Serialisation ─────────────────────────────────────────────────────── */

  toBuffer() {
    if (this.pages.length === 0) {
      throw new Error("Refusing to write a PDF with no pages. Call page() first.");
    }

    /**
     * Object 1 catalogue, 2 page tree, 3–5 the three faces, 6 the info
     * dictionary, then a page object and a content object per page. Fixed
     * numbering keeps the file readable when someone opens it in an editor to
     * check what the generator actually emitted.
     */
    const FIRST_PAGE_OBJ = 7;
    const objects = [];
    const pageNums = this.pages.map((_, i) => FIRST_PAGE_OBJ + i * 2);

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] =
      `<< /Type /Pages /Count ${this.pages.length} ` +
      `/Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] >>`;
    for (const [name, { resource }] of Object.entries(FONTS)) {
      const index = Number(resource.slice(1)) + 2;
      objects[index] =
        `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
    }
    /*
     * The creation date defaults to a fixed instant rather than `now`.
     *
     * That is not laziness: two runs of the fixture generator have to produce
     * byte-identical files, or the duplicate-document fixture stops sharing a
     * hash with the invoice it duplicates and the deduplication test silently
     * stops testing anything.
     *
     * A caller producing a real document — a review package somebody is about
     * to send — passes its own date and producer instead, because a pack
     * stamped April 2025 forever is a small lie printed on a tax document.
     */
    objects[6] =
      `<< /Producer (${pdfText(this.producer)}) ` +
      `/Creator (${pdfText(this.creator)}) ` +
      `/CreationDate (${pdfText(this.creationDate)}) >>`;

    this.pages.forEach((page, i) => {
      const pageNum = pageNums[i];
      const contentNum = pageNum + 1;
      const stream = page.ops.join("\n");
      objects[pageNum] =
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> ` +
        `/Contents ${contentNum} 0 R >>`;
      objects[contentNum] =
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });

    // A binary comment on line 2 is what tells a transfer agent the file is not
    // text and must not have its line endings translated.
    const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [];

    for (let n = 1; n < objects.length; n += 1) {
      const body = Buffer.from(`${n} 0 obj\n${objects[n]}\nendobj\n`, "latin1");
      offsets[n] = offset;
      offset += body.length;
      chunks.push(body);
    }

    const size = objects.length;
    const startxref = offset;
    // Every xref entry is exactly 20 bytes. A reader seeks by multiplying, so a
    // short line does not shift one entry, it corrupts every entry after it.
    const rows = ["0000000000 65535 f \n"];
    for (let n = 1; n < size; n += 1) {
      rows.push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    }
    chunks.push(
      Buffer.from(
        `xref\n0 ${size}\n${rows.join("")}` +
          `trailer\n<< /Size ${size} /Root 1 0 R /Info 6 0 R >>\n` +
          `startxref\n${startxref}\n%%EOF`,
        "latin1",
      ),
    );

    return Buffer.concat(chunks);
  }

  async save(file) {
    const bytes = this.toBuffer();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return bytes;
  }
}

export default Pdf;
