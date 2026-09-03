"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  CopyButton,
  DraftBanner,
  DraftMark,
  ErrorNote,
  Loading,
  Money,
  Note,
  NotLoaded,
  Section,
  Segmented,
  Table,
  Td,
  Toolbar,
  Tr,
  When,
} from "@/components/ui";
import { categoryName } from "@/lib/categories";
import type { FormDraft } from "@/lib/types";

/**
 * The drafts.
 *
 * This is the screen that looks most like a finished tax return, which makes it
 * the screen where a reader is most likely to forget it is not one. So the word
 * DRAFT is in the header, on the picker, and in a banner above the figures, and
 * no control here does anything but regenerate.
 *
 * The two amount columns are the other thing this screen exists to show.
 * `recorded` is what the documents add up to; `amount` is what reaches the
 * line. They differ for meals at 50%, for anything capitalised, and for costs
 * that belong on a different form — and a reviewer checking a line against a
 * pile of receipts needs to see why, on the line, not in a footnote.
 */
export function FormsPanel() {
  const [drafts, setDrafts] = useState<FormDraft[] | null>(null);
  const [active, setActive] = useState<string>("schedule-c");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/forms");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Forms responded ${response.status}.`);
      setDrafts(value.drafts as FormDraft[]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drafts could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Forms responded ${response.status}.`);
      setNote(`${value.generated} drafts generated from the categorised documents.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drafts could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  const draft = useMemo(
    () => drafts?.find((d) => d.formId === active) ?? drafts?.[0],
    [drafts, active],
  );

  const generateButton = (
    <Button variant="primary" busy={busy} onClick={generate}>
      {drafts?.length ? "Regenerate drafts" : "Generate the drafts"}
    </Button>
  );

  if (error && !drafts) return <ErrorNote title="The drafts could not be read">{error}</ErrorNote>;
  if (!drafts) return <Loading rows={6} label="Reading the drafts…" />;

  if (drafts.length === 0) {
    return (
      <div className="space-y-4">
        {error && <ErrorNote title="The last run failed">{error}</ErrorNote>}
        <NotLoaded what="The draft forms" action={generateButton} />
      </div>
    );
  }

  if (!draft) return <Loading rows={4} />;

  const currency = draft.totals[0]?.currency ?? "USD";
  const adjusted = draft.lines.filter((line) => Math.abs(line.amount - line.recorded) >= 0.005);

  return (
    <div className="space-y-6">
      {error && <ErrorNote title="The last run failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <DraftBanner disclaimer={draft.disclaimer} />

      <Toolbar>
        <Segmented
          options={drafts.map((d) => ({
            id: d.formId,
            label:
              d.formId === "schedule-c"
                ? "Schedule C"
                : d.formId === "1099-nec-summary"
                  ? "1099-NEC"
                  : "1040-ES",
          }))}
          value={draft.formId}
          onChange={setActive}
        />
        <span className="text-[12.5px] text-ink-3">
          Generated <When at={draft.generatedAt} relative />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton
            label="Copy the figures"
            text={draft.lines
              .map((l) => `${l.line}\t${l.label}\t${l.recorded.toFixed(2)}\t${l.amount.toFixed(2)}`)
              .join("\n")}
          />
          {generateButton}
        </div>
      </Toolbar>

      <Section
        title={draft.formName}
        description="Every figure is arithmetic over the categorised documents. No model computed any of them."
        actions={<DraftMark />}
      >
        <Table
          minWidth={880}
          head={[
            { label: "Line", width: "70px" },
            { label: "Description" },
            { label: "Docs", align: "right", width: "70px" },
            { label: "Recorded", align: "right", width: "130px" },
            { label: "On the line", align: "right", width: "130px" },
            { label: "Flags", width: "90px" },
          ]}
        >
          {draft.lines.map((line) => {
            const differs = Math.abs(line.amount - line.recorded) >= 0.005;
            return (
              <Tr key={`${line.line}-${line.label}`}>
                <Td className="tnum font-mono text-[12px] text-ink-3">{line.line}</Td>
                <Td>
                  <span className="font-medium">{line.label}</span>
                  {line.adjustmentNote && (
                    <p className="mt-0.5 max-w-xl text-[12px] text-warn-ink">{line.adjustmentNote}</p>
                  )}
                  {line.categoryIds.length > 0 && (
                    <p className="mt-0.5 max-w-xl text-[11.5px] text-ink-3">
                      {line.categoryIds.map(categoryName).join(" · ")}
                    </p>
                  )}
                </Td>
                <Td align="right" className="tnum text-ink-3">
                  {line.docCount || "—"}
                </Td>
                <Td align="right" className="text-ink-2">
                  <Money amount={line.recorded} currency={line.currency ?? currency} />
                </Td>
                <Td align="right" className={differs ? "font-medium text-warn-ink" : "font-medium"}>
                  <Money amount={line.amount} currency={line.currency ?? currency} />
                </Td>
                <Td>
                  {line.openExceptionIds.length > 0 ? (
                    <Badge state="medium" label={`${line.openExceptionIds.length}`} dot />
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
      </Section>

      {draft.totals.length > 0 && (
        <Section title="Totals">
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            {draft.totals.map((total) => (
              <div
                key={total.label}
                className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <span className="text-[13px] font-medium">{total.label}</span>
                <span className="text-[15px] font-semibold">
                  <Money amount={total.amount} currency={total.currency} />
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {adjusted.length > 0 && (
        <Note>
          <p className="font-medium">Lines where the two columns differ</p>
          {adjusted.map((line) => (
            <p key={line.line} className="mt-1 text-[12.5px]">
              Line {line.line}, {line.label}: <Money amount={line.recorded} currency={currency} />{" "}
              recorded, <Money amount={line.amount} currency={currency} /> on the line.{" "}
              {line.adjustmentNote}
            </p>
          ))}
        </Note>
      )}

      {draft.unmappedCategoryIds.length > 0 && (
        <ErrorNote title="Money that reached no line on this form">
          <p className="mt-1">
            {draft.unmappedCategoryIds.map(categoryName).join(", ")}. This is a hole in the draft,
            not a rounding difference — the amounts are real and no line on this form takes them.
            They belong somewhere else, or the categorisation needs a person.
          </p>
        </ErrorNote>
      )}

      {draft.openExceptionIds.length > 0 && (
        <Note>
          {draft.openExceptionIds.length} findings were still open when this draft was generated. No
          line on it is final until they are dealt with.
        </Note>
      )}
    </div>
  );
}
