"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * The component kit.
 *
 * Everything the console draws comes from here. One kit rather than per-panel
 * markup is not tidiness — it is the only way nine screens agree on what a
 * severity looks like, and a severity that renders differently on two screens
 * is a severity nobody trusts.
 *
 * Colours come from the semantic tokens in `globals.css`. Nothing in this file
 * writes a hex value.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Surfaces
 * ────────────────────────────────────────────────────────────────────────── */

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface shadow-card ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** A titled block. `actions` sits on the baseline of the title, right-aligned. */
export function Section({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-3 ${className}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Numbers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A KPI tile.
 *
 * `value` is `React.ReactNode` and `null`/`undefined` renders an em dash, never
 * a zero. "We did not compute this" and "this is zero" are different answers,
 * and a tile that shows 0 for the first is the console lying quietly.
 */
export function Stat({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "brand" | "warn" | "crit" | "ok";
  href?: string;
}) {
  const accent = {
    default: "text-ink",
    brand: "text-brand",
    warn: "text-warn-ink",
    crit: "text-crit-ink",
    ok: "text-ok-ink",
  }[tone];

  const body = (
    <>
      <div className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</div>
      <div className={`tnum mt-1.5 text-[26px] leading-none font-semibold ${accent}`}>
        {value === null || value === undefined ? <span className="text-ink-3">—</span> : value}
      </div>
      {hint && <div className="mt-1.5 text-[12px] text-ink-3">{hint}</div>}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block rounded-xl border border-border bg-surface p-4 shadow-card transition hover:border-border-strong"
      >
        {body}
      </a>
    );
  }
  return <div className="rounded-xl border border-border bg-surface p-4 shadow-card">{body}</div>;
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/**
 * Money.
 *
 * `amount` of `null` or `undefined` is an em dash. A missing total on an
 * unreadable scan must never render as `$0.00` — that is a document silently
 * contributing nothing to a return while looking accounted for.
 */
export function Money({
  amount,
  currency = "USD",
  className = "",
  signed = false,
}: {
  amount?: number | null;
  currency?: string;
  className?: string;
  signed?: boolean;
}) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return <span className={`text-ink-3 ${className}`}>—</span>;
  }
  const formatted = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(amount);
  const sign = signed && amount > 0 ? "+" : "";
  return (
    <span className={`tnum whitespace-nowrap ${className}`}>
      {sign}
      {formatted}
    </span>
  );
}

/** A 0–1 confidence, as a bar and a figure. Low values are visibly low. */
export function Confidence({ value }: { value?: number }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "bg-ok-ink" : value >= 0.7 ? "bg-warn-ink" : "bg-crit-ink";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="tnum text-[12px] text-ink-2">{pct}%</span>
    </span>
  );
}

/** Dates in the viewer's timezone, never a raw ISO string. */
export function When({
  at,
  relative = false,
  dateOnly = false,
}: {
  at?: string;
  relative?: boolean;
  dateOnly?: boolean;
}) {
  if (!at) return <span className="text-ink-3">—</span>;
  // A bare `YYYY-MM-DD` parses as UTC midnight, which in a western timezone
  // renders as the previous day. Pin it to local noon so an invoice dated the
  // 1st never displays as the 31st.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00` : at;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="text-ink-3">—</span>;

  const absolute = date.toLocaleString(undefined, {
    dateStyle: "medium",
    ...(dateOnly ? {} : { timeStyle: "short" }),
  });
  return (
    <span title={at} className="tnum whitespace-nowrap">
      {relative ? `${ago(date)} · ${absolute}` : absolute}
    </span>
  );
}

function ago(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const future = seconds < 0;
  const n = Math.abs(seconds);
  let label = `${Math.round(n / 2592000)}mo`;
  if (n < 60) label = `${n}s`;
  else if (n < 3600) label = `${Math.round(n / 60)}m`;
  else if (n < 86400) label = `${Math.round(n / 3600)}h`;
  else if (n < 2592000) label = `${Math.round(n / 86400)}d`;
  return future ? `in ${label}` : `${label} ago`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Badges
 * ────────────────────────────────────────────────────────────────────────── */

type Tone = "ok" | "warn" | "crit" | "info" | "neutral" | "brand";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok-ink ring-ok-line",
  warn: "bg-warn-bg text-warn-ink ring-warn-line",
  crit: "bg-crit-bg text-crit-ink ring-crit-line",
  info: "bg-info-bg text-info-ink ring-info-line",
  neutral: "bg-neutral-bg text-neutral-ink ring-neutral-line",
  brand: "bg-brand-soft text-brand ring-brand-line",
};

/** Every state in the app, mapped to a tone. Unknown states fall to neutral. */
const STATE_TONE: Record<string, Tone> = {
  // Document and extraction state
  extracted: "ok",
  classified: "ok",
  matched: "ok",
  unreadable: "crit",
  failed: "crit",
  pending: "warn",
  unknown: "neutral",

  // What one document's turn through the pipeline came to. "reused" is its own
  // colour on purpose — it says the model was not called, which is the whole
  // reason the Drive output folder exists.
  computed: "ok",
  reused: "info",
  declined: "neutral",
  uploading: "info",
  queued: "neutral",
  working: "warn",
  reading: "warn",

  // Exception state — "accepted" and "open" must never look alike. Accepted
  // means a person looked and decided it was fine; open means nobody has.
  open: "warn",
  resolved: "ok",
  accepted: "info",

  // Severity
  high: "crit",
  medium: "warn",
  low: "neutral",

  // Category kind
  income: "ok",
  expense: "info",
  cogs: "info",
  asset: "warn",
  "non-deductible": "neutral",


  // Period and package
  draft: "warn",
  packaged: "info",
  "handed-off": "ok",

  // Sources
  drive: "info",
  gmail: "info",
  upload: "neutral",
  fixture: "neutral",
};

/**
 * A state, told apart by its word first and its colour second.
 *
 * The label is never dropped. Two flags distinguishable only by hue is how a
 * medium gets read as a high — and worse, how a high gets read as a medium and
 * a wrong return goes out.
 */
export function Badge({
  state,
  label,
  tone,
  dot = false,
  className = "",
}: {
  state?: string;
  label?: string;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const resolved: Tone = tone ?? (state ? (STATE_TONE[state] ?? "neutral") : "neutral");
  const text = label ?? state?.replace(/-/g, " ") ?? "";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset ${TONE_CLASS[resolved]} ${className}`}
    >
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" />}
      {text}
    </span>
  );
}

/** Severity, with the word spelled out and a filled dot. Always both. */
export function Severity({ level }: { level: "high" | "medium" | "low" }) {
  return <Badge state={level} label={level} dot />;
}

/** A key/id, in mono at a size that does not shout. */
export function Mono({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={`rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2 ${className}`}>
      {children}
    </code>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Notes
 * ────────────────────────────────────────────────────────────────────────── */

function noteBox(tone: Tone) {
  return function Note({ children, title }: { children?: React.ReactNode; title?: string }) {
    if (!children && !title) return null;
    return (
      <div className={`rounded-lg px-3.5 py-3 text-[13px] ring-1 ring-inset ${TONE_CLASS[tone]}`}>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? "mt-1 opacity-90" : ""}>{children}</div>}
      </div>
    );
  };
}

export const Note = noteBox("warn");
export const ErrorNote = noteBox("crit");
export const OkNote = noteBox("ok");
export const InfoNote = noteBox("info");

/* ────────────────────────────────────────────────────────────────────────────
 * States
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Nothing here.
 *
 * Distinct from `NotLoaded` on purpose, and the distinction is the most
 * important one in this console: a section that shows "nothing here" when a
 * fetch actually failed is telling the reviewer their books are clean.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-[14px] font-medium">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Not fetched, not computed, not known. Never renders as an empty result. */
export function NotLoaded({ what, action }: { what: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-sunken/50 px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-ink-2">{what} has not been computed yet.</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-3">
        This is not the same as nothing being found.
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function Loading({ rows = 5, label }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {label && <p className="text-[13px] text-ink-3">{label}</p>}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Controls
 * ────────────────────────────────────────────────────────────────────────── */

export function Button({
  children,
  variant = "secondary",
  size = "md",
  busy = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "brand";
  size?: "sm" | "md";
  busy?: boolean;
}) {
  const styles = {
    primary: "bg-solid text-solid-ink hover:bg-solid-hover",
    secondary: "border border-border bg-surface text-ink hover:border-border-strong hover:bg-sunken",
    ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
    danger: "bg-crit-ink text-white hover:opacity-90",
    brand: "bg-brand text-white hover:bg-brand-ink",
  }[variant];

  const dims = size === "sm" ? "h-7 px-2.5 text-[12.5px] gap-1.5" : "h-9 px-3.5 text-[13px] gap-2";

  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-45 ${dims} ${styles} ${className}`}
    >
      {busy && (
        <span
          aria-hidden
          className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none transition placeholder:text-ink-3 hover:border-border-strong focus:border-brand";

export const textareaClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-ink-3 hover:border-border-strong focus:border-brand";

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center gap-1 text-[13px] font-medium">
        {label}
        {required && <span className="text-brand">*</span>}
      </span>
      {children}
      {error ? (
        <span className="block text-[12px] text-crit-ink">{error}</span>
      ) : (
        hint && <span className="block text-[12px] text-ink-3">{hint}</span>
      )}
    </label>
  );
}

export function Toolbar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

/** Search box with the magnifier drawn inline — no icon dependency. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4 4" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputClass} pl-8`}
      />
    </div>
  );
}

/** Segmented filter control. The selected segment carries the count. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-sunken p-0.5">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition ${
              active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink"
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={`tnum text-[11px] ${active ? "text-ink-3" : "text-ink-3"}`}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** In-panel tabs. Section navigation is the sidebar's job, not this. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { id: T; label: string; badge?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border" role="tablist">
      {tabs.map((tab) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition ${
              on
                ? "border-brand text-ink"
                : "border-transparent text-ink-2 hover:border-border-strong hover:text-ink"
            }`}
          >
            {tab.label}
            {tab.badge ? (
              <span className="tnum rounded bg-sunken px-1.5 text-[11px] text-ink-2">{tab.badge}</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
}: {
  text: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tables
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A data table.
 *
 * The header sticks, horizontal scrolling belongs to the table rather than the
 * page, and there are no vertical rules — on a dense grid they add ink without
 * adding structure. `align` is per column so money right-aligns and reads down
 * the column.
 */
export function Table({
  head,
  children,
  minWidth = 720,
  className = "",
}: {
  head: { label: React.ReactNode; align?: "left" | "right" | "center"; width?: string }[];
  children: React.ReactNode;
  minWidth?: number;
  className?: string;
}) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-border bg-surface ${className}`}>
      <table className="w-full text-left text-[13px]" style={{ minWidth }}>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border">
            {head.map((cell, i) => (
              <th
                key={i}
                style={cell.width ? { width: cell.width } : undefined}
                className={`px-3 py-2.5 text-[11.5px] font-medium tracking-wide text-ink-3 uppercase ${
                  cell.align === "right"
                    ? "text-right"
                    : cell.align === "center"
                      ? "text-center"
                      : "text-left"
                }`}
              >
                {cell.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Tr({
  children,
  onClick,
  active = false,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={`${onClick ? "cursor-pointer" : ""} transition hover:bg-sunken ${
        active ? "bg-brand-soft" : ""
      } ${className}`}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
  colSpan,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  const alignment = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <td colSpan={colSpan} className={`px-3 py-2.5 align-middle ${alignment} ${className}`}>
      {children}
    </td>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Overlays
 * ────────────────────────────────────────────────────────────────────────── */

function useDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);
}

/**
 * A side sheet.
 *
 * Document detail lives here rather than in a centred modal: a reviewer reads
 * an invoice against the row it came from, and a dialog that covers the table
 * makes them close it to check what they were comparing.
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  actions,
  children,
  width = "max-w-3xl",
}: {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  useDismiss(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        className={`relative flex h-full w-full ${width} flex-col border-l border-border bg-elevated shadow-pop`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-2">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  useDismiss(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`rise relative w-full ${width} rounded-xl border border-border bg-elevated shadow-pop`}
      >
        <h2 className="border-b border-border px-5 py-4 text-[15px] font-semibold">{title}</h2>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The confirmation gate.
 *
 * It states the consequence rather than asking "are you sure": accepting an
 * exception and resolving one look identical in a dialog that only says
 * confirm, and they mean different things to whoever reads the register next.
 *
 * `requireNote` is the one piece of friction kept deliberately. A resolution
 * with no note is a row that says somebody dealt with this and nothing about
 * what they did — six months later that is indistinguishable from nobody
 * having looked.
 */
export function Confirm({
  open,
  title,
  consequence,
  confirmLabel,
  variant = "primary",
  busy,
  requireNote = false,
  notePlaceholder = "What was done, and why this can be closed.",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  variant?: "primary" | "danger" | "brand";
  busy?: boolean;
  requireNote?: boolean;
  notePlaceholder?: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Clear the note when the dialog closes rather than in an effect: the
  // component returns null below, so an effect would set state on something
  // that renders nothing. This is React's adjust-state-during-render pattern.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open && note !== "") setNote("");
  }

  useEffect(() => {
    if (open && requireNote) noteRef.current?.focus();
  }, [open, requireNote]);

  const blocked = requireNote && note.trim().length === 0;

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={variant}
            busy={busy}
            disabled={blocked}
            onClick={() => onConfirm(note.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{consequence}</p>
      {children}
      {requireNote && (
        <div className="space-y-1.5">
          <label htmlFor={noteId} className="block text-[13px] font-medium">
            Note <span className="text-brand">*</span>
          </label>
          <textarea
            id={noteId}
            ref={noteRef}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={notePlaceholder}
            disabled={busy}
            className={textareaClass}
          />
          <p className="text-[12px] text-ink-3">
            Recorded against this in the audit trail. A closed item with no note reads later as
            one nobody looked at.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Draft marking
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The DRAFT marker.
 *
 * On every rendering of a form, without exception. This is the screen where a
 * reader is most likely to forget what they are looking at, because it is the
 * screen that looks most like a finished return.
 */
export function DraftMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md bg-brand px-2 py-0.5 font-mono text-[11px] font-semibold tracking-[0.14em] text-white uppercase ${className}`}
    >
      Draft
    </span>
  );
}

export function DraftBanner({ disclaimer }: { disclaimer: string }) {
  return (
    <div className="rounded-xl border border-brand-line bg-brand-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <DraftMark />
        <span className="text-[13px] font-medium text-ink">Not filed. Not final.</span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{disclaimer}</p>
    </div>
  );
}
