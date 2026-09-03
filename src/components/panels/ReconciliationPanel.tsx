"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  Money,
  Note,
  NotLoaded,
  Section,
  Stat,
  StatGrid,
  Table,
  Td,
  Tr,
  When,
} from "@/components/ui";
import type { DocumentView, LedgerEntry, Match } from "@/lib/types";

type Summary = {
  currency: string;
  matched: { match: Match; doc?: DocumentView; entry?: LedgerEntry }[];
  documentOnly: { match: Match; doc: DocumentView }[];
  ledgerOnly: { match: Match; entry: LedgerEntry }[];
};

/**
 * Documents against the books.
 *
 * The ledger-only rows lead, and they lead on every screen size, because they
 * are the reason anyone opens this: the books say money moved and there is no
 * receipt to show for it. Matched rows are reassurance and go last.
 *
 * Nothing here offers to fix anything. Where a matched pair disagrees the
 * difference is shown in full, both figures side by side, because the
 * difference is the finding — a reconciliation that quietly agreed with itself
 * would have destroyed the only evidence that something went wrong.
 */
export function ReconciliationPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/reconcile");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Reconciliation responded ${response.status}.`);
      setSummary(value as Summary);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reconciliation could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function rerun() {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/reconcile", { method: "POST" });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Reconciliation responded ${response.status}.`);
      setNote(
        `${value.matched} matched, ${value.ledgerOnly} ledger rows with no document, ` +
          `${value.documentOnly} documents with no ledger row, ${value.amountMismatches} amounts that disagree.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reconciliation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !summary) {
    return <ErrorNote title="The reconciliation could not be read">{error}</ErrorNote>;
  }
  if (!summary) return <Loading rows={6} label="Pairing documents against the ledger…" />;

  const currency = summary.currency;
  const mismatches = summary.matched.filter((m) => Math.abs(m.match.amountDelta ?? 0) >= 0.01);
  const total = summary.matched.length + summary.documentOnly.length + summary.ledgerOnly.length;

  const action = (
    <Button variant="secondary" busy={busy} onClick={rerun}>
      Reconcile again
    </Button>
  );

  if (total === 0) {
    return (
      <div className="space-y-4">
        {error && <ErrorNote title="The last run failed">{error}</ErrorNote>}
        <NotLoaded what="The reconciliation" action={action} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && <ErrorNote title="The last run failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <StatGrid>
        <Stat
          label="No receipt"
          value={summary.ledgerOnly.length}
          tone={summary.ledgerOnly.length > 0 ? "crit" : "default"}
          hint="ledger rows with nothing behind them"
        />
        <Stat
          label="Amounts disagree"
          value={mismatches.length}
          tone={mismatches.length > 0 ? "crit" : "default"}
          hint="paired, but the figures differ"
        />
        <Stat
          label="No ledger row"
          value={summary.documentOnly.length}
          tone={summary.documentOnly.length > 0 ? "warn" : "default"}
          hint="documents the books do not account for"
        />
        <Stat label="Matched" value={summary.matched.length} tone="ok" hint="document and ledger agree" />
      </StatGrid>

      <Section
        title="Ledger rows with no supporting document"
        description="The books say money moved. There is no receipt on file for it."
        actions={action}
      >
        {summary.ledgerOnly.length === 0 ? (
          <Empty title="Every ledger row has a document behind it" />
        ) : (
          <Table
            minWidth={780}
            head={[
              { label: "Date", width: "120px" },
              { label: "Description" },
              { label: "Counterparty", width: "180px" },
              { label: "Reference", width: "150px" },
              { label: "Amount", align: "right", width: "130px" },
            ]}
          >
            {summary.ledgerOnly.map(({ match, entry }) => (
              <Tr key={match.id}>
                <Td className="text-ink-2">
                  <When at={entry?.date} dateOnly />
                </Td>
                <Td>{entry?.description ?? <span className="text-ink-3">—</span>}</Td>
                <Td className="text-ink-2">{entry?.counterparty ?? "—"}</Td>
                <Td className="text-ink-3">{entry?.ref ?? "—"}</Td>
                <Td align="right" className="font-medium text-crit-ink">
                  <Money amount={entry?.amount} currency={entry?.currency ?? currency} />
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>

      {mismatches.length > 0 && (
        <Section
          title="Paired, but the amounts disagree"
          description="Both figures are shown. Neither is adjusted — the difference is the finding."
        >
          <Table
            minWidth={820}
            head={[
              { label: "Document" },
              { label: "Ledger row" },
              { label: "On the document", align: "right", width: "140px" },
              { label: "In the books", align: "right", width: "140px" },
              { label: "Difference", align: "right", width: "120px" },
            ]}
          >
            {mismatches.map(({ match, doc, entry }) => (
              <Tr key={match.id}>
                <Td>
                  <span className="block max-w-[240px] truncate" title={doc?.doc.filename}>
                    {doc?.doc.filename ?? "—"}
                  </span>
                </Td>
                <Td className="text-ink-2">{entry?.description ?? "—"}</Td>
                <Td align="right">
                  <Money amount={doc?.extraction?.total} currency={currency} />
                </Td>
                <Td align="right">
                  <Money amount={entry?.amount} currency={entry?.currency ?? currency} />
                </Td>
                <Td align="right" className="font-medium text-crit-ink">
                  <Money amount={Math.abs(match.amountDelta ?? 0)} currency={currency} />
                </Td>
              </Tr>
            ))}
          </Table>
        </Section>
      )}

      <Section
        title="Documents with no ledger row"
        description="A receipt exists for something the books do not record."
      >
        {summary.documentOnly.length === 0 ? (
          <Empty title="Every document is accounted for in the ledger" />
        ) : (
          <Table
            minWidth={780}
            head={[
              { label: "Document" },
              { label: "Vendor", width: "180px" },
              { label: "Date", width: "120px" },
              { label: "Amount", align: "right", width: "130px" },
              { label: "Why unmatched", width: "220px" },
            ]}
          >
            {summary.documentOnly.map(({ match, doc }) => (
              <Tr key={match.id}>
                <Td>
                  <span className="block max-w-[240px] truncate" title={doc.doc.filename}>
                    {doc.doc.filename}
                  </span>
                </Td>
                <Td className="text-ink-2">{doc.extraction?.vendor ?? "—"}</Td>
                <Td className="text-ink-2">
                  <When at={doc.extraction?.issueDate} dateOnly />
                </Td>
                <Td align="right">
                  <Money amount={doc.extraction?.total} currency={doc.extraction?.currency ?? currency} />
                </Td>
                <Td className="text-[12px] text-ink-3">{match.reasons.join("; ") || "—"}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Matched" description="Document and ledger row agree on amount and date.">
        {summary.matched.length === 0 ? (
          <Empty title="Nothing paired" />
        ) : (
          <Table
            minWidth={820}
            head={[
              { label: "Document" },
              { label: "Ledger row" },
              { label: "Date", width: "120px" },
              { label: "Amount", align: "right", width: "130px" },
              { label: "Confidence", width: "110px" },
            ]}
          >
            {summary.matched.map(({ match, doc, entry }) => (
              <Tr key={match.id}>
                <Td>
                  <span className="block max-w-[240px] truncate" title={doc?.doc.filename}>
                    {doc?.doc.filename ?? "—"}
                  </span>
                </Td>
                <Td className="text-ink-2">{entry?.description ?? "—"}</Td>
                <Td className="text-ink-2">
                  <When at={entry?.date} dateOnly />
                </Td>
                <Td align="right">
                  <Money amount={entry?.amount} currency={entry?.currency ?? currency} />
                </Td>
                <Td>
                  <Badge
                    state={match.score >= 0.85 ? "matched" : "medium"}
                    label={`${Math.round(match.score * 100)}%`}
                  />
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
