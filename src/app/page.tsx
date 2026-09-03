"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { ThemeToggle } from "@/components/shell";
import { UserPicker } from "@/components/UserPicker";
import { Money } from "@/components/ui";
import type { PrepStatus } from "@/lib/types";

/**
 * The front door.
 *
 * It states the period's actual state rather than describing the product,
 * because anyone opening this has a filing to get through and the useful first
 * sentence is "nine things are flagged", not "we help you organise documents".
 *
 * The pipeline row does the explaining that feature cards usually do badly:
 * seven stages in order, each a link into the console at that stage. What the
 * product does and how to reach it are the same object.
 */

type Stage = {
  id: string;
  label: string;
  icon: IconName;
  blurb: string;
};

const PIPELINE: Stage[] = [
  { id: "documents", label: "Collect", icon: "upload", blurb: "Drives and inboxes into one workspace" },
  { id: "documents", label: "Extract", icon: "receipt", blurb: "Vendor, dates and figures off each page" },
  { id: "categories", label: "Categorise", icon: "categories", blurb: "Against the firm's tax chart" },
  { id: "reconciliation", label: "Reconcile", icon: "reconciliation", blurb: "Documents against the ledger" },
  { id: "exceptions", label: "Flag", icon: "flag", blurb: "Every difference, with its reason" },
  { id: "forms", label: "Draft", icon: "forms", blurb: "Schedule C, 1099-NEC, 1040-ES" },
  { id: "package", label: "Package", icon: "package", blurb: "Handed to a person to review" },
];

export default function Home() {
  const [status, setStatus] = useState<PrepStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // `undefined` is "not asked yet", `null` is "asked, nobody is selected".
  // Collapsing them would flash the picker at somebody who already has a
  // workspace open on every reload.
  const [user, setUser] = useState<{ id: string; name: string } | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch("/api/users/active")
      .then((r) => r.json())
      .then((body) => live && setUser(body?.active ?? null))
      .catch(() => live && setUser(null));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let live = true;
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => live && setStatus(body as PrepStatus))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [user]);

  if (user === undefined) return <div className="min-h-dvh bg-bg" />;
  if (user === null) {
    return <UserPicker onEntered={(entered) => setUser(entered)} />;
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      {/* One faint brand wash. The only decorative use of red in the product. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-48 h-[420px] bg-[radial-gradient(50%_60%_at_50%_50%,var(--brand),transparent_70%)] opacity-[0.07]"
      />

      <div className="relative mx-auto max-w-5xl px-6 py-12 sm:py-16">
        <header className="flex items-center justify-between gap-6">
          <Image
            src="/logo.png"
            alt="NDI — New Digital Intelligence"
            width={301}
            height={168}
            priority
            className="logo h-9 w-auto"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setUser(null)}
              title="Switch workspace"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-ink-2 transition hover:border-border-strong hover:text-ink"
            >
              <span className="flex size-5 items-center justify-center rounded bg-brand-soft text-[10px] font-semibold text-brand uppercase">
                {user.name.slice(0, 2)}
              </span>
              {user.name}
            </button>
            <ThemeToggle />
            <Link
              href="/prep"
              className="inline-flex h-9 items-center rounded-lg bg-solid px-3.5 text-[13px] font-medium text-solid-ink transition hover:bg-solid-hover"
            >
              Open the console
            </Link>
          </div>
        </header>

        <section className="mt-12 max-w-2xl">
          <p className="font-mono text-[11px] font-medium tracking-[0.22em] text-brand uppercase">
            DO-09
          </p>
          <h1 className="mt-3 text-[2.4rem] leading-[1.08] font-semibold sm:text-[3rem]">
            Tax Document
            <br />
            Preparation Assistant
          </h1>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            Collects invoices and receipts, sorts them by tax category, pre-fills draft forms, and
            flags every inconsistency for a person instead of papering over it.
          </p>
          <p className="mt-4 flex items-start gap-2 text-[14px] font-medium">
            <span className="mt-0.5 inline-block h-4 w-0.5 shrink-0 rounded-full bg-brand" />
            <span>
              Nothing here files anything. Every form is a draft, and a tax manager decides.
            </span>
          </p>
        </section>

        <StatusStrip status={status} failed={failed} />

        <section className="mt-14">
          <h2 className="text-[11px] font-medium tracking-[0.14em] text-ink-3 uppercase">
            The pipeline
          </h2>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE.map((stage, i) => (
              <li key={stage.label}>
                <Link
                  href={`/prep?section=${stage.id}`}
                  className="group flex h-full flex-col rounded-xl border border-border bg-surface p-4 shadow-card transition hover:border-border-strong"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-sunken text-ink-2 transition group-hover:text-brand">
                      <Icon name={stage.icon} className="size-4" />
                    </span>
                    <span className="tnum font-mono text-[11px] text-ink-3">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <p className="mt-3 text-[14px] font-medium">{stage.label}</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{stage.blurb}</p>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-[12.5px] text-ink-3">
          <p>Prepared, never filed. A person reviews every package.</p>
          <p className="font-mono text-[11px] tracking-[0.16em] uppercase">
            New Digital Intelligence
          </p>
        </footer>
      </div>
    </div>
  );
}

/**
 * The live state, above the fold.
 *
 * A failed status call renders as a failed status call. Zeroing these would
 * turn "the server did not answer" into "the period is empty and clean", which
 * is the single failure mode this whole console is built to avoid.
 */
function StatusStrip({ status, failed }: { status: PrepStatus | null; failed: boolean }) {
  if (failed) {
    return (
      <div className="mt-10 rounded-xl border border-crit-line bg-crit-bg px-4 py-3 text-[13px] text-crit-ink">
        The period could not be read, so there is nothing to report here yet. Run{" "}
        <code className="font-mono">npm run fixtures &amp;&amp; npm run seed</code>, then reload.
      </div>
    );
  }

  const cells = [
    { label: "Period", value: status?.period.label, mono: false },
    { label: "Documents", value: status ? String(status.counts.documents) : undefined, mono: true },
    {
      label: "Open flags",
      value: status ? String(status.exceptions.open) : undefined,
      mono: true,
      alert: (status?.exceptions.open ?? 0) > 0,
    },
    {
      label: "Gross receipts",
      value: status ? undefined : undefined,
      money: status?.money.grossReceipts,
      currency: status?.money.currency,
    },
  ];

  return (
    <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.label} className="bg-surface px-4 py-3.5">
          <p className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{cell.label}</p>
          <p
            className={`tnum mt-1 text-[19px] font-semibold ${cell.alert ? "text-brand" : "text-ink"}`}
          >
            {"money" in cell && cell.money !== undefined ? (
              <Money amount={cell.money} currency={cell.currency ?? "USD"} />
            ) : cell.value === undefined ? (
              <span className="skeleton inline-block h-5 w-16 rounded" />
            ) : (
              cell.value
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
