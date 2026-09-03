"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Empty,
  ErrorNote,
  InfoNote,
  Loading,
  Money,
  Section,
  Segmented,
  Stat,
  StatGrid,
  Table,
  Td,
  Toolbar,
  Tr,
} from "@/components/ui";
import type { CategoryKind, TaxCategory } from "@/lib/types";

type Row = TaxCategory & { recorded: number; deductible: number; docCount: number };
type Filter = "used" | "all" | "review";

/**
 * Totals by category.
 *
 * The two columns that matter sit side by side: what the documents add up to,
 * and what actually reaches a form line. They differ for meals (50%), for
 * anything capitalised, and for costs that belong on another form entirely.
 *
 * Showing only the second would be tidier and would break the screen's purpose.
 * A reviewer holding the restaurant receipts adds them to $310.80, sees $155.40
 * on the form, and concludes the app lost half their expenses — unless both
 * numbers and the reason are in front of them.
 */
export function CategoriesPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("used");

  useEffect(() => {
    let live = true;
    fetch("/api/categories")
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error ?? `Categories responded ${response.status}.`);
        if (!live) return;
        setRows(value.categories as Row[]);
        setCurrency(value.currency ?? "USD");
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "The chart could not be read.");
      });
    return () => {
      live = false;
    };
  }, []);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      all: all.length,
      used: all.filter((r) => r.docCount > 0).length,
      review: all.filter((r) => r.alwaysReview && r.docCount > 0).length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const all = rows ?? [];
    if (filter === "all") return all;
    if (filter === "review") return all.filter((r) => r.alwaysReview && r.docCount > 0);
    return all.filter((r) => r.docCount > 0);
  }, [rows, filter]);

  const totals = useMemo(() => {
    const used = (rows ?? []).filter((r) => r.docCount > 0);
    const by = (kinds: CategoryKind[]) =>
      used.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.recorded, 0);
    return {
      income: by(["income"]),
      expenses: by(["expense", "cogs"]),
      deductible: used
        .filter((r) => r.kind === "expense" || r.kind === "cogs")
        .reduce((n, r) => n + r.deductible, 0),
      offForm: by(["asset", "non-deductible"]),
    };
  }, [rows]);

  if (error) return <ErrorNote title="The category chart could not be read">{error}</ErrorNote>;
  if (!rows) return <Loading rows={8} label="Adding up the categories…" />;

  const anySorted = counts.used > 0;
  const adjusted = visible.filter((r) => r.docCount > 0 && r.deductible !== r.recorded);

  return (
    <div className="space-y-6">
      {!anySorted && (
        <InfoNote title="Nothing has been sorted yet">
          The chart below is the firm&rsquo;s full list of categories. Run categorisation from
          Documents and the totals will fill in. Everything reads zero because nothing has been
          placed, not because the period is empty.
        </InfoNote>
      )}

      <StatGrid>
        <Stat
          label="Income"
          value={anySorted ? <Money amount={totals.income} currency={currency} /> : null}
        />
        <Stat
          label="Expenses recorded"
          value={anySorted ? <Money amount={totals.expenses} currency={currency} /> : null}
        />
        <Stat
          label="Reaching a form line"
          value={anySorted ? <Money amount={totals.deductible} currency={currency} /> : null}
          hint="after every adjustment below"
        />
        <Stat
          label="Off the form"
          value={anySorted ? <Money amount={totals.offForm} currency={currency} /> : null}
          hint="capitalised, personal, or another form"
          tone={totals.offForm > 0 ? "warn" : "default"}
        />
      </StatGrid>

      {adjusted.length > 0 && (
        <InfoNote title="Where the two columns differ">
          {adjusted.map((r) => (
            <p key={r.id} className="mt-1">
              <strong>{r.name}</strong> — <Money amount={r.recorded} currency={currency} /> recorded,{" "}
              <Money amount={r.deductible} currency={currency} /> on the line.{" "}
              {r.deductiblePct !== undefined
                ? `Only ${Math.round(r.deductiblePct * 100)}% of this category is deductible.`
                : r.kind === "asset"
                  ? "Capitalised — depreciated on Form 4562, not expensed here."
                  : "Not deductible on this form."}
            </p>
          ))}
        </InfoNote>
      )}

      <Section
        title="The chart"
        description="The firm's categories, what landed in each, and which ones a person has to decide."
        actions={
          <Toolbar>
            <Segmented
              options={[
                { id: "used" as Filter, label: "In use", count: counts.used },
                { id: "review" as Filter, label: "Needs a decision", count: counts.review },
                { id: "all" as Filter, label: "Whole chart", count: counts.all },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </Toolbar>
        }
      >
        {visible.length === 0 ? (
          <Empty
            title="No category matches that"
            hint="Switch to the whole chart to see every category the firm defines."
          />
        ) : (
          <Table
            minWidth={900}
            head={[
              { label: "Category" },
              { label: "Form line", width: "200px" },
              { label: "Kind", width: "120px" },
              { label: "Docs", align: "right", width: "70px" },
              { label: "Recorded", align: "right", width: "130px" },
              { label: "On the line", align: "right", width: "130px" },
            ]}
          >
            {visible.map((row) => {
              const differs = row.docCount > 0 && row.deductible !== row.recorded;
              return (
                <Tr key={row.id}>
                  <Td>
                    <span className="font-medium">{row.name}</span>
                    {row.alwaysReview && (
                      <span className="ml-2 align-middle">
                        <Badge state="medium" label="a person decides" dot />
                      </span>
                    )}
                    {row.deductiblePct !== undefined && (
                      <span className="ml-2 align-middle">
                        <Badge tone="info" label={`${Math.round(row.deductiblePct * 100)}%`} />
                      </span>
                    )}
                    {row.alwaysReview && row.reviewReason && (
                      <p className="mt-1 max-w-xl text-[12px] text-ink-3">{row.reviewReason}</p>
                    )}
                  </Td>
                  <Td className="text-ink-2">{row.formLine}</Td>
                  <Td>
                    <Badge state={row.kind} />
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {row.docCount || <span className="text-ink-3">—</span>}
                  </Td>
                  <Td align="right">
                    {row.docCount ? (
                      <Money amount={row.recorded} currency={currency} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                  <Td align="right" className={differs ? "text-warn-ink" : ""}>
                    {row.docCount ? (
                      <Money amount={row.deductible} currency={currency} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Section>
    </div>
  );
}
