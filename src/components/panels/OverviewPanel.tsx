"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import {
  Button,
  ErrorNote,
  InfoNote,
  Loading,
  Money,
  Note,
  Section,
  Stat,
  StatGrid,
  Toolbar,
} from "@/components/ui";
import type { PrepStatus } from "@/lib/types";

type Status = PrepStatus & { preparerConfigured?: boolean; taxManagerConfigured?: boolean };

/**
 * Where the period stands.
 *
 * Every money figure arrives as `null` until the step that produces it has
 * run, and `<Stat>` draws a `null` as an em dash. That is the whole discipline
 * of this screen: gross receipts of nothing is a period with no income, and a
 * dash is a period nobody has read yet. Showing the second as the first is the
 * one mistake that would make the rest of the console untrustworthy.
 */
export function OverviewPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/status");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Status responded ${response.status}.`);
      setStatus(value as Status);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The period could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(label: string, path: string) {
    setRunning(label);
    setNote("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `${label} responded ${response.status}.`);
      setNote(summarise(label, value));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} failed.`);
    } finally {
      setRunning(null);
    }
  }

  if (error && !status) return <ErrorNote title="The period could not be read">{error}</ErrorNote>;
  if (!status) return <Loading rows={4} label="Reading the period…" />;

  const c = status.counts;
  const pipeline: { label: string; path: string; icon: IconName; ready: boolean; hint: string }[] = [
    {
      label: "Extract",
      path: "/api/extract",
      icon: "receipt",
      ready: c.pendingExtraction > 0,
      hint: c.pendingExtraction > 0 ? `${c.pendingExtraction} unread` : "all read",
    },
    {
      label: "Categorise",
      path: "/api/classify",
      icon: "categories",
      ready: c.pendingClassification > 0,
      hint: c.pendingClassification > 0 ? `${c.pendingClassification} unsorted` : "all sorted",
    },
    {
      label: "Reconcile",
      path: "/api/reconcile",
      icon: "reconciliation",
      ready: c.matched + c.documentOnly + c.ledgerOnly === 0,
      hint: `${c.ledgerEntries} ledger rows`,
    },
    {
      label: "Detect",
      path: "/api/exceptions/detect",
      icon: "flag",
      ready: true,
      hint: `${status.exceptions.open} open`,
    },
    {
      label: "Draft forms",
      path: "/api/forms",
      icon: "forms",
      ready: status.forms.length === 0,
      hint: status.forms.length ? `${status.forms.length} drafted` : "none yet",
    },
  ];

  return (
    <div className="space-y-8">
      {error && <ErrorNote title="The last action failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      {!status.modelConfigured && (
        <ErrorNote title="No API key, so nothing can be read off a document">
          ANTHROPIC_API_KEY is not set. Collection, reconciliation and the flag engine still work;
          extraction and categorisation are the two steps that need a model, and they are blocked
          rather than faked.
        </ErrorNote>
      )}

      <Section
        title="The period"
        description={`${status.period.entity} · ${status.period.start} to ${status.period.end} · ${status.period.basis} basis · ${status.period.jurisdiction}`}
      >
        <StatGrid>
          <Stat label="Documents" value={c.documents} hint={`${c.extracted} read, ${c.pendingExtraction} not yet`} />
          <Stat
            label="Open flags"
            value={status.exceptions.open}
            tone={status.exceptions.open > 0 ? "brand" : "default"}
            hint={
              status.exceptions.open
                ? `${status.exceptions.high} high, ${status.exceptions.medium} medium, ${status.exceptions.low} low`
                : "nothing waiting on a person"
            }
          />
          <Stat
            label="Needs a decision"
            value={c.needsReview}
            tone={c.needsReview > 0 ? "warn" : "default"}
            hint="categorisations a person must confirm"
          />
          <Stat
            label="Could not be read"
            value={c.unreadable}
            tone={c.unreadable > 0 ? "crit" : "default"}
            hint="on the flag list with their filenames"
          />
        </StatGrid>
      </Section>

      <Section title="Money" description="Blank until the documents have been read and sorted.">
        <StatGrid>
          <Stat
            label="Gross receipts"
            value={
              status.money.grossReceipts === null ? null : (
                <Money amount={status.money.grossReceipts} currency={status.money.currency} />
              )
            }
          />
          <Stat
            label="Expenses recorded"
            value={
              status.money.totalExpenses === null ? null : (
                <Money amount={status.money.totalExpenses} currency={status.money.currency} />
              )
            }
          />
          <Stat
            label="Reaching a form line"
            value={
              status.money.deductibleExpenses === null ? null : (
                <Money amount={status.money.deductibleExpenses} currency={status.money.currency} />
              )
            }
            hint="after the 50% meals rule and the capitalised items"
          />
          <Stat
            label="Off the form"
            value={
              status.money.unclassified === null ? null : (
                <Money amount={status.money.unclassified} currency={status.money.currency} />
              )
            }
            hint="personal, capitalised, or on another form"
          />
        </StatGrid>
      </Section>

      <Section
        title="Run the pipeline"
        description="Each step is safe to run again. Detection keeps the notes on findings that still apply."
      >
        <Toolbar>
          {pipeline.map((step) => (
            <Button
              key={step.label}
              variant={step.ready ? "primary" : "secondary"}
              busy={running === step.label}
              disabled={Boolean(running)}
              onClick={() => run(step.label, step.path)}
            >
              <Icon name={step.icon} className="size-3.5" />
              {step.label}
              <span className="text-[11.5px] opacity-60">{step.hint}</span>
            </Button>
          ))}
        </Toolbar>
      </Section>

      <Section title="Where the documents came from">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {status.sources.map((source) => (
            <div key={source.source} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium capitalize">{source.source}</span>
                <span className="tnum text-[13px] text-ink-2">
                  {source.available ? source.documents : "—"}
                </span>
              </div>
              {source.detail && <p className="mt-1.5 text-[12px] text-ink-3">{source.detail}</p>}
            </div>
          ))}
        </div>
      </Section>

      <InfoNote title="Nothing here files anything">
        Every form this console produces is a draft, and a tax manager decides. Differences between
        a document and the ledger are reported, never adjusted away — the difference is the finding.
      </InfoNote>
    </div>
  );
}

/** Turn a run's result into one sentence a person can read. */
function summarise(label: string, value: Record<string, unknown>): string {
  const n = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : undefined);

  if (label === "Extract") {
    return `Read ${n("extracted") ?? 0} of ${n("run") ?? 0}. ${n("unreadable") ?? 0} could not be read and ${n("failed") ?? 0} failed — both are on the flag list, not dropped.`;
  }
  if (label === "Categorise") {
    return `Sorted ${n("classified") ?? 0}. ${n("needsReview") ?? 0} need a person's decision.`;
  }
  if (label === "Reconcile") {
    return `${n("matched") ?? 0} matched, ${n("ledgerOnly") ?? 0} ledger rows with no document, ${n("documentOnly") ?? 0} documents with no ledger row, ${n("amountMismatches") ?? 0} amounts that disagree.`;
  }
  if (label === "Detect") {
    return `${n("raised") ?? 0} findings, ${n("carriedForward") ?? 0} carried forward with the notes already on them.`;
  }
  if (label === "Draft forms") {
    return `${n("generated") ?? 0} drafts generated. Every one is a draft and stays one.`;
  }
  return `${label} finished.`;
}
