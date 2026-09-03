"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

/**
 * The frame every console screen sits in.
 *
 * A persistent left rail rather than a tab bar, for one reason that outweighs
 * the rest: the open-flag count stays visible while you work somewhere else.
 * This is a tool whose whole job is to surface things a person has to look at,
 * and a tab strip hides that number the moment you leave the tab it lives on.
 */

export type Section = {
  id: string;
  label: string;
  icon: IconName;
  blurb: string;
  /** Key into the `counts` map the shell is given. */
  countKey?: string;
  /** A count on this section means something needs attention, not just volume. */
  alerting?: boolean;
};

export const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", icon: "overview", blurb: "Where the period stands" },
  {
    id: "documents",
    label: "Documents",
    icon: "documents",
    blurb: "Everything collected, and what was read off it",
    countKey: "documents",
  },
  { id: "categories", label: "Categories", icon: "categories", blurb: "Totals by tax category" },
  {
    id: "exceptions",
    label: "Exceptions",
    icon: "exceptions",
    blurb: "Everything flagged for a person",
    countKey: "openExceptions",
    alerting: true,
  },
  { id: "forms", label: "Draft forms", icon: "forms", blurb: "Schedule C, 1099-NEC, 1040-ES" },
  { id: "package", label: "Package", icon: "package", blurb: "The review-ready handoff" },
  { id: "ask", label: "Ask", icon: "ask", blurb: "Question the register" },
  { id: "audit", label: "Audit", icon: "audit", blurb: "Append-only trail" },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Command palette
 * ────────────────────────────────────────────────────────────────────────── */

type Command = { id: string; label: string; hint: string; run: () => void };

/**
 * Cmd-K navigation.
 *
 * A convenience and never the only route to anything: every command here is
 * also a visible control somewhere. A palette that hides a capability is a
 * capability most people will never find.
 */
export function CommandPalette({
  onNavigate,
  extra = [],
}: {
  onNavigate: (id: string) => void;
  extra?: Command[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((was) => !was);
        setQuery("");
        setCursor(0);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(
    () => [
      ...SECTIONS.map((section) => ({
        id: `go-${section.id}`,
        label: section.label,
        hint: section.blurb,
        run: () => onNavigate(section.id),
      })),
      ...extra,
    ],
    [onNavigate, extra],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
    );
  }, [commands, query]);

  if (!open) return null;

  const choose = (command: Command) => {
    command.run();
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="rise relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-elevated shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Icon name="search" className="size-4 shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (event.key === "Enter" && matches[cursor]) choose(matches[cursor]);
            }}
            placeholder="Go to a section, or run something…"
            className="h-11 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches that.</li>
          )}
          {matches.map((command, i) => (
            <li key={command.id}>
              <button
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(command)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition ${
                  i === cursor ? "bg-sunken" : ""
                }`}
              >
                <span className="text-[13px] font-medium">{command.label}</span>
                <span className="truncate text-[12px] text-ink-3">{command.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shell
 * ────────────────────────────────────────────────────────────────────────── */

function NavCount({ value, alerting }: { value?: number; alerting?: boolean }) {
  if (value === undefined || value === null) return null;

  // Zero open items is a real, good state and must not look like an alert.
  // Colouring every count red teaches people that red means "a number",
  // and then a genuine flag reads as decoration.
  const hot = Boolean(alerting) && value > 0;

  return (
    <span
      className={`tnum ml-auto inline-flex items-center gap-1 rounded px-1.5 text-[11px] font-medium ${
        hot ? "bg-brand-soft text-brand" : "text-ink-3"
      }`}
    >
      {hot && <span className="size-1 rounded-full bg-brand" />}
      {value}
    </span>
  );
}

function NavItem({
  section,
  active,
  count,
  onClick,
}: {
  section: Section;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={section.blurb}
      className={`relative flex w-full items-center gap-2.5 rounded-lg py-1.5 pr-2 pl-3 text-[13px] transition ${
        active
          ? "bg-brand-soft font-medium text-ink"
          : "text-ink-2 hover:bg-sunken hover:text-ink"
      }`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand"
        />
      )}
      <Icon name={section.icon} className={`size-4 shrink-0 ${active ? "text-brand" : ""}`} />
      <span className="truncate">{section.label}</span>
      <NavCount value={count} alerting={section.alerting} />
    </button>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 -mx-5 mb-5 border-b border-border bg-bg/85 px-5 py-3.5 backdrop-blur lg:-mx-8 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold">{title}</h1>
          {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function AppShell({
  children,
  active,
  counts = {},
  period,
  user,
  onNavigate,
  onEditPeriod,
}: {
  children: React.ReactNode;
  active: string;
  counts?: Partial<Record<string, number>>;
  /** The active period. Absent renders as "no period loaded", never as a guess. */
  period?: {
    label: string;
    entity: string;
    start: string;
    end: string;
    currency: string;
    basis: "cash" | "accrual";
  };
  /** Opens the period editor. Absent leaves the period block read-only. */
  onEditPeriod?: () => void;
  /** Whose workspace this is. Always visible: it scopes everything on screen. */
  user?: { id: string; name: string };
  onNavigate?: (id: string) => void;
}) {
  const navigate = useCallback(
    (id: string) => {
      if (onNavigate) onNavigate(id);
      else window.location.search = `?section=${id}`;
    },
    [onNavigate],
  );

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <CommandPalette onNavigate={navigate} />

      {/* Sidebar on lg and up; a scrollable strip below it, so the flag count
          is never hidden behind a hamburger. */}
      <aside className="sticky top-0 z-30 shrink-0 border-b border-border bg-surface lg:h-dvh lg:w-[232px] lg:border-r lg:border-b-0">
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 px-4 py-3.5 lg:py-4">
            <Link href="/" className="flex min-w-0 items-center gap-2.5">
              {/* `.logo` in globals.css multiplies away the PNG's white ground. */}
              <Image
                src="/logo.png"
                alt="NDI — New Digital Intelligence"
                width={301}
                height={168}
                priority
                className="logo h-5 w-auto"
              />
              <span className="font-mono text-[10px] tracking-[0.18em] text-ink-3 uppercase">
                DO-09
              </span>
            </Link>
          </div>

          <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-1 lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:pb-0">
            {SECTIONS.map((section) => (
              <div key={section.id} className="shrink-0 lg:shrink lg:w-full">
                <NavItem
                  section={section}
                  active={section.id === active}
                  count={section.countKey ? counts[section.countKey] : undefined}
                  onClick={() => navigate(section.id)}
                />
              </div>
            ))}
          </nav>

          <div className="hidden border-t border-border px-4 py-3 lg:block">
            {/* Whose workspace, first. Everything above is scoped to it, and a
                console that did not say so lets somebody read one person's
                figures believing they are another's. */}
            {user && (
              <a
                href="/"
                title="Switch workspace"
                className="mb-2.5 flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-[12px] transition hover:border-border-strong"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-brand-soft text-[10px] font-semibold text-brand uppercase">
                  {user.name.slice(0, 2)}
                </span>
                <span className="truncate font-medium">{user.name}</span>
                <span className="ml-auto text-ink-3">↔</span>
              </a>
            )}
            {/* The period is editable from here because here is where it is
                read. It shipped as a guess — a quarter from a past year under a
                fixture company name — and a label somebody cannot correct
                where they see it is one they end up ignoring. */}
            {period && onEditPeriod ? (
              <button
                type="button"
                onClick={onEditPeriod}
                title="Edit the filing period"
                className="group block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-sunken"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium">{period.label}</span>
                  <Icon
                    name="chevron"
                    className="size-3 text-ink-3 opacity-0 transition group-hover:opacity-100"
                  />
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">
                  {period.entity}
                </span>
              </button>
            ) : (
              <>
                <p className="text-[12px] font-medium">{period?.label ?? "No period loaded"}</p>
                <p className="mt-0.5 truncate text-[11.5px] text-ink-3">{period?.entity ?? "—"}</p>
              </>
            )}
            <p className="mt-2 flex items-center gap-1 text-[11px] text-ink-3">
              <Icon name="command" className="size-3" />
              <span>K to search</span>
            </p>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 pb-16 lg:px-8">{children}</main>
    </div>
  );
}
