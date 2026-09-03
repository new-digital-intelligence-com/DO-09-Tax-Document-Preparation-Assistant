/**
 * Types for `pdf-lite.mjs`, which is plain ESM shared by two callers that
 * cannot both be TypeScript: the fixture generator runs as a bare node script,
 * and the package renderer runs inside Next. Declaring the surface here rather
 * than porting the implementation keeps one copy of the font metrics — two
 * would drift, and a text-width table that disagrees with itself produces
 * right-aligned columns that are quietly wrong.
 */
export type PdfColor = [number, number, number];

export interface TextOptions {
  font?: "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Courier" | "Courier-Bold";
  size?: number;
  color?: PdfColor;
  charSpace?: number;
}

export class Pdf {
  constructor(options?: {
    width?: number;
    height?: number;
    producer?: string;
    creator?: string;
    /** `D:YYYYMMDDHHmmSSZ`. Defaults to a fixed instant so fixture runs stay byte-identical. */
    creationDate?: string;
  });
  /** Format a Date as the `D:…Z` string a PDF reader accepts. */
  static stamp(date?: Date): string;
  page(options?: { width?: number; height?: number }): this;
  widthOf(value: string, options?: TextOptions): number;
  text(x: number, y: number, value: string, options?: TextOptions): this;
  textRight(x: number, y: number, value: string, options?: TextOptions): this;
  textCentre(x: number, y: number, value: string, options?: TextOptions): this;
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options?: { color?: PdfColor; lineWidth?: number },
  ): this;
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    options?: { fill?: PdfColor; stroke?: PdfColor; lineWidth?: number },
  ): this;
  toBuffer(): Buffer;
}

export default Pdf;
