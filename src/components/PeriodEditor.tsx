"use client";

import { useState } from "react";
import { Button, Dialog, ErrorNote, Field, inputClass } from "@/components/ui";

/**
 * What this filing period is called, who it is for, and what it covers.
 *
 * All three shipped as a guess this app had no way to make: a quarter from a
 * past year under a fixture company name. Somebody preparing their own 2026
 * invoices was reading a heading that was wrong about the year and wrong about
 * the company, with nowhere to correct either.
 *
 * The dates are the one field here that means less than it looks like it does,
 * and the hint says so. Nothing is rejected for falling outside them — a
 * document is read on its own terms — but they are printed on every draft
 * form, so they should still be true.
 */
export function PeriodEditor({
  open,
  period,
  onClose,
  onSaved,
}: {
  open: boolean;
  period: {
    label: string;
    entity: string;
    start: string;
    end: string;
    currency: string;
    basis: "cash" | "accrual";
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(period);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Reopening on a period that has since changed should show the change, not
  // a stale draft. Adjusted during render rather than in an effect, so the
  // dialog never paints the old values first.
  const [seen, setSeen] = useState(period);
  if (open && seen !== period) {
    setSeen(period);
    setDraft(period);
  }

  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings/period", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Saving responded ${response.status}.`);
      onClose();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The period could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="The filing period"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {error && <ErrorNote title="That could not be saved">{error}</ErrorNote>}

      <Field label="Period" hint="Printed at the top of every draft form. Call it whatever you file it as.">
        <input
          value={draft.label}
          onChange={(event) => set({ label: event.target.value })}
          placeholder="2026 Q3"
          className={inputClass}
        />
      </Field>

      <Field label="Entity" hint="The business this return is for.">
        <input
          value={draft.entity}
          onChange={(event) => set({ entity: event.target.value })}
          placeholder="Your company name"
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <input
            type="date"
            value={draft.start}
            onChange={(event) => set({ start: event.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={draft.end}
            onChange={(event) => set({ end: event.target.value })}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="-mt-1 text-[12px] text-ink-3">
        These dates are printed on the forms. No document is rejected or flagged for falling
        outside them — everything you add is read on its own terms.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Currency" hint="Totals are added up in this.">
          <input
            value={draft.currency}
            onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
            maxLength={3}
            placeholder="USD"
            className={inputClass}
          />
        </Field>
        <Field label="Basis">
          <select
            value={draft.basis}
            onChange={(event) => set({ basis: event.target.value as "cash" | "accrual" })}
            className={inputClass}
          >
            <option value="cash">Cash</option>
            <option value="accrual">Accrual</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
