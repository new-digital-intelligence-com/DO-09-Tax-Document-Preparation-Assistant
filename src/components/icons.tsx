/**
 * The icon set, drawn inline.
 *
 * No image files and no icon dependency: every glyph takes `currentColor`, so
 * the active sidebar item needs no second asset and a glyph on a red ground
 * needs no recolouring.
 *
 * Each one depicts the thing it names. A row of interchangeable rounded squares
 * is faster to draw and useless to navigate by — the whole value of an icon in
 * a nine-item sidebar is that it is recognisable before the label is read.
 */

export type IconName =
  | "overview"
  | "documents"
  | "categories"
  | "exceptions"
  | "forms"
  | "package"
  | "ask"
  | "audit"
  | "drive"
  | "gmail"
  | "upload"
  | "search"
  | "close"
  | "check"
  | "alert"
  | "chevron"
  | "external"
  | "copy"
  | "command"
  | "download"
  | "refresh"
  | "flag"
  | "receipt"
  | "arrow";

const PATHS: Record<IconName, React.ReactNode> = {
  /* A dashboard: one wide panel and two stacked. */
  overview: (
    <>
      <rect x="3.5" y="3.5" width="8" height="7" rx="1.6" />
      <rect x="14" y="3.5" width="6.5" height="17" rx="1.6" />
      <rect x="3.5" y="13.5" width="8" height="7" rx="1.6" />
    </>
  ),

  /* A document with a folded corner and ruled lines. */
  documents: (
    <>
      <path d="M6 3.5h7.5L18.5 8v12.5H6z" />
      <path d="M13.2 3.6V8h4.9" />
      <path d="M8.6 12h6M8.6 15.2h6M8.6 18.3h3.4" />
    </>
  ),

  /* Tagged buckets: three labelled shelves. */
  categories: (
    <>
      <path d="M3.5 6.2h11.2l2.8 2.6-2.8 2.6H3.5z" />
      <path d="M20.5 14.6H9.3l-2.8 2.6 2.8 2.6h11.2z" />
    </>
  ),


  /* A flag on a pole — the product's own mark. */
  exceptions: (
    <>
      <path d="M6 21V3.6" />
      <path d="M6 4.4h11.4l-2.2 4 2.2 4H6z" />
    </>
  ),

  /* A form: a sheet with a filled field and a signature rule. */
  forms: (
    <>
      <rect x="4.5" y="3" width="15" height="18" rx="2" />
      <path d="M8 8h8M8 11.6h8" />
      <path d="M8 16.2h5" />
    </>
  ),

  /* A box, closed and taped. */
  package: (
    <>
      <path d="M12 3.2 3.8 7.1v9.8L12 20.8l8.2-3.9V7.1z" />
      <path d="M3.9 7.2 12 11l8.1-3.8M12 11v9.7" />
    </>
  ),

  /* A speech bubble with a tail. */
  ask: (
    <>
      <path d="M20.5 12.4c0 4.1-3.8 7.4-8.5 7.4a9.9 9.9 0 0 1-2.6-.35L4.3 21l1.3-3.7A7 7 0 0 1 3.5 12.4C3.5 8.3 7.3 5 12 5s8.5 3.3 8.5 7.4Z" />
      <path d="M9.8 10.4a2.3 2.3 0 0 1 4.4.8c0 1.6-2.2 1.7-2.2 3.1" />
      <path d="M12 16.6h.01" />
    </>
  ),

  /* A time-ordered list — the trail. */
  audit: (
    <>
      <circle cx="6" cy="6.4" r="1.9" />
      <circle cx="6" cy="17.6" r="1.9" />
      <path d="M6 8.3v7.4" />
      <path d="M10.8 6.4h9.2M10.8 12h6.6M10.8 17.6h9.2" />
    </>
  ),

  /* Drive's three-facet triangle, reduced to strokes. */
  drive: (
    <>
      <path d="m9.4 3.5 5.2 9h-10.4z" />
      <path d="m14.6 12.5 5.2 0-5.2 8-5.2-8z" />
      <path d="M4.2 12.5 9.4 3.5" opacity="0" />
    </>
  ),

  /* An envelope with the fold. */
  gmail: (
    <>
      <rect x="2.8" y="5" width="18.4" height="14" rx="2.4" />
      <path d="m3.6 7 8.4 6 8.4-6" />
    </>
  ),

  upload: (
    <>
      <path d="M12 16.5V4.2" />
      <path d="m7.6 8.4 4.4-4.3 4.4 4.3" />
      <path d="M4.5 15.4v2.9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.9" />
    </>
  ),

  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.3 4.3" />
    </>
  ),

  close: <path d="m6 6 12 12M18 6 6 18" />,

  check: <path d="m5 12.6 4.5 4.4L19 7.4" />,

  alert: (
    <>
      <path d="M12 4.2 2.9 19.6h18.2z" />
      <path d="M12 10v4.1M12 17h.01" />
    </>
  ),

  chevron: <path d="m9 5.5 6.5 6.5L9 18.5" />,

  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19 5 11.4 12.6" />
      <path d="M18.4 14v4.4a2 2 0 0 1-2 2H5.9a2 2 0 0 1-2-2V7.8a2 2 0 0 1 2-2h4.4" />
    </>
  ),

  copy: (
    <>
      <rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2" />
      <path d="M15.4 5.6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2" />
    </>
  ),

  command: (
    <path d="M8.4 3.6a2.4 2.4 0 1 1 2.4 2.4v12a2.4 2.4 0 1 1-2.4-2.4h7.2a2.4 2.4 0 1 1-2.4 2.4V6a2.4 2.4 0 1 1 2.4-2.4Z" />
  ),

  download: (
    <>
      <path d="M12 3.8v12.4" />
      <path d="m7.6 11.8 4.4 4.4 4.4-4.4" />
      <path d="M4.5 17.2v1.1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.1" />
    </>
  ),

  refresh: (
    <>
      <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6" />
      <path d="M20 3.6v5h-5" />
    </>
  ),

  flag: (
    <>
      <path d="M6 21V3.6" />
      <path d="M6 4.4h11.4l-2.2 4 2.2 4H6z" />
    </>
  ),

  /* A till receipt with a torn foot. */
  receipt: (
    <>
      <path d="M5.5 3.6h13v17.2l-2.2-1.4-2.2 1.4-2.1-1.4-2.2 1.4-2.1-1.4-2.2 1.4z" />
      <path d="M9 8.4h6M9 12.2h6M9 15.6h3.4" />
    </>
  ),

  arrow: (
    <>
      <path d="M4.5 12h15" />
      <path d="m14.2 6.7 5.3 5.3-5.3 5.3" />
    </>
  ),
};

export function Icon({
  name,
  className = "size-4",
  strokeWidth = 1.6,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
