"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Confirm,
  Empty,
  ErrorNote,
  InfoNote,
  Loading,
  Money,
  Mono,
  Note,
  Section,
  SearchInput,
  Segmented,
  Severity,
  Stat,
  StatGrid,
  Toolbar,
  When,
} from "@/components/ui";
import type { TaxException } from "@/lib/types";

type Payload = {
  currency: string;
  exceptions: TaxException[];
  counts: {
    total: number;
    open: number;
    resolved: number;
    accepted: number;
    high: number;
    medium: number;
    low: number;
  };
};

type Filter = "open" | "high" | "closed" | "all";

/** What each closing action means, in the words the dialog uses. */
const ACTIONS = {
  resolve: {
    verb: "Resolve",
    title: "Resolve this finding",
    consequence:
      "Resolved means the underlying problem was fixed — a better scan arrived, the total was " +
      "corrected, the duplicate was removed. It is a different statement from accepting the " +
      "finding as it stands, and the next person to read the register will act on which one you chose.",
    placeholder: "What was fixed, and how you confirmed it.",
    variant: "primary" as const,
  },
  accept: {
    verb: "Accept",
    title: "Accept this finding as it stands",
    consequence:
      "Accepted means a person looked and decided this is fine — nothing was changed and nothing " +
      "needs to be. The finding stays visible in the register with your note against it, which is " +
      "what tells a reviewer later that it was considered rather than missed.",
    placeholder: "Why this is fine as it stands.",
    variant: "brand" as const,
  },
  reopen: {
    verb: "Reopen",
    title: "Reopen this finding",
    consequence:
      "It goes back on the open list and counts against the period again. The earlier note stays " +
      "in the audit trail — nothing is erased by reopening.",
    placeholder: "Why this needs looking at again.",
    variant: "danger" as const,
  },
};

/**
 * The flag list.
 *
 * This is the screen the product exists for, and two decisions shape it.
 *
 * Severity is a word before it is a colour. Reading a medium as a high costs an
 * hour; reading a high as a medium files a wrong return, and a reader who is
 * colourblind, tired, or looking at a bad monitor should be in no danger of
 * either.
 *
 * Resolve and Accept are kept apart everywhere — different buttons, different
 * dialogs, different badges, different words. Collapsing them into "close"
 * would lose exactly the distinction the next reviewer needs: was this fixed,
 * or was it looked at and judged acceptable.
 */
export function ExceptionsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [drafting, setDrafting] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{
    exception: TaxException;
    action: keyof typeof ACTIONS;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/exceptions");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Exceptions responded ${response.status}.`);
      setData(value as Payload);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The findings could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function redetect() {
    setBusy("detect");
    setNote("");
    try {
      const response = await fetch("/api/exceptions/detect", { method: "POST" });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Detection responded ${response.status}.`);
      setNote(
        `${value.raised} findings. ${value.carriedForward} were already on file and kept the notes ` +
          `you wrote on them.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Detection failed.");
    } finally {
      setBusy(null);
    }
  }

  async function close(note: string) {
    if (!pending) return;
    setBusy(pending.exception.id);
    try {
      const response = await fetch("/api/exceptions/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: pending.exception.id,
          note,
          accept: pending.action === "accept",
          reopen: pending.action === "reopen",
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `The finding responded ${response.status}.`);
      setPending(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The finding could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  async function draft(exception: TaxException) {
    setDrafting(exception.id);
    const vendorRequest = exception.kind === "missing-period";
    try {
      const response = await fetch("/api/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          vendorRequest
            ? {
                kind: "vendor-request",
                vendor: exception.title.replace(/^[^—-]*[—-]\s*/, "") || exception.title,
                items: [{ finding: exception.title, detail: exception.detail, amount: exception.amount }],
              }
            : {
                kind: "exception-note",
                title: exception.title,
                detail: exception.detail,
                suggestedAction: exception.suggestedAction,
              },
        ),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Drafting responded ${response.status}.`);
      setDrafts((prior) => ({ ...prior, [exception.id]: value.text }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be written.");
    } finally {
      setDrafting(null);
    }
  }

  const rows = useMemo(() => {
    const all = data?.exceptions ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((exception) => {
      if (filter === "open" && exception.status !== "open") return false;
      if (filter === "high" && !(exception.status === "open" && exception.severity === "high")) {
        return false;
      }
      if (filter === "closed" && exception.status === "open") return false;
      if (!q) return true;
      return [exception.title, exception.detail, exception.kind]
        .some((field) => field.toLowerCase().includes(q));
    });
  }, [data, filter, query]);

  if (error && !data) return <ErrorNote title="The findings could not be read">{error}</ErrorNote>;
  if (!data) return <Loading rows={6} label="Reading the findings…" />;

  const c = data.counts;
  const detectButton = (
    <Button variant="secondary" busy={busy === "detect"} onClick={redetect}>
      Detect again
    </Button>
  );

  return (
    <div className="space-y-6">
      {error && <ErrorNote title="The last action failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <StatGrid>
        <Stat label="High" value={c.high} tone={c.high > 0 ? "crit" : "default"} hint="look at these first" />
        <Stat label="Medium" value={c.medium} tone={c.medium > 0 ? "warn" : "default"} />
        <Stat label="Low" value={c.low} />
        <Stat
          label="Closed"
          value={c.resolved + c.accepted}
          tone="ok"
          hint={`${c.resolved} fixed, ${c.accepted} accepted as they stand`}
        />
      </StatGrid>

      {c.total === 0 && (
        <InfoNote title="Detection has not run for this period">
          That is not the same as a clean period. Run it and the findings will be whatever the rules
          and the documents actually produce.
        </InfoNote>
      )}

      <Section
        title="Findings"
        description="Every one names its figures and what would close it. Nothing here is fixed automatically."
        actions={
          <Toolbar>
            <Segmented
              options={[
                { id: "open" as Filter, label: "Open", count: c.open },
                { id: "high" as Filter, label: "High", count: c.high },
                { id: "closed" as Filter, label: "Closed", count: c.resolved + c.accepted },
                { id: "all" as Filter, label: "All", count: c.total },
              ]}
              value={filter}
              onChange={setFilter}
            />
            <SearchInput value={query} onChange={setQuery} placeholder="Search findings…" className="w-56" />
            {detectButton}
          </Toolbar>
        }
      >
        {rows.length === 0 ? (
          <Empty
            title={
              c.total === 0
                ? "Nothing detected yet"
                : filter === "open"
                  ? "Nothing is waiting on a person"
                  : "Nothing matches that"
            }
            hint={
              c.total === 0
                ? "Run detection to compute the period's findings."
                : filter === "open"
                  ? "Every finding has been resolved or accepted, each with a note against it."
                  : undefined
            }
            action={c.total === 0 ? detectButton : undefined}
          />
        ) : (
          <ul className="space-y-2.5">
            {rows.map((exception) => (
              <li
                key={exception.id}
                className="rounded-xl border border-border bg-surface p-4 shadow-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Severity level={exception.severity} />
                      <Badge state={exception.status} />
                      <Mono>{exception.kind}</Mono>
                    </div>
                    <h3 className="text-[14px] font-medium">{exception.title}</h3>
                    <p className="max-w-3xl text-[13px] leading-relaxed text-ink-2">
                      {exception.detail}
                    </p>
                    <p className="max-w-3xl text-[12.5px] leading-relaxed text-ink-3">
                      <span className="font-medium text-ink-2">What would close it: </span>
                      {exception.suggestedAction}
                    </p>
                    {exception.status !== "open" && exception.resolutionNote && (
                      <p className="max-w-3xl rounded-lg bg-sunken px-3 py-2 text-[12.5px] text-ink-2">
                        <span className="font-medium">
                          {exception.status === "accepted" ? "Accepted" : "Resolved"} by{" "}
                          {exception.resolvedBy} · <When at={exception.resolvedAt} relative />
                        </span>
                        <br />
                        {exception.resolutionNote}
                      </p>
                    )}
                    {drafts[exception.id] && (
                      <div className="max-w-3xl space-y-2 rounded-lg border border-border bg-sunken p-3">
                        <p className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">
                          Drafted for you — check it before using it
                        </p>
                        <p className="text-[12.5px] whitespace-pre-wrap text-ink-2">
                          {drafts[exception.id]}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {exception.amount !== undefined && (
                      <span className="text-[15px] font-semibold">
                        <Money amount={exception.amount} currency={exception.currency ?? data.currency} />
                      </span>
                    )}
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {/* Offered once. A second draft over a first one replaces
                          text somebody may already have edited or sent, and the
                          button gives no hint that it would. Once there is a
                          draft, the only thing on offer is rewriting it, and
                          that is asked for explicitly. */}
                      {drafts[exception.id] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={drafting === exception.id}
                          onClick={() => draft(exception)}
                          title="Replaces the draft below"
                        >
                          Rewrite
                        </Button>
                      ) : (
                        exception.status === "open" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={drafting === exception.id}
                            onClick={() => draft(exception)}
                          >
                            {exception.kind === "missing-period" ? "Draft the request" : "Draft a note"}
                          </Button>
                        )
                      )}
                      {exception.status === "open" ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            title="Nothing was changed — you looked and it is fine as it stands"
                            onClick={() => setPending({ exception, action: "accept" })}
                          >
                            Accept as is
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            title="The underlying problem was fixed"
                            onClick={() => setPending({ exception, action: "resolve" })}
                          >
                            Fixed
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setPending({ exception, action: "reopen" })}
                        >
                          Reopen
                        </Button>
                      )}
                    </div>
                    {exception.docIds.length > 0 && (
                      <a
                        href={`/prep?section=documents`}
                        className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                      >
                        {exception.docIds.length} document{exception.docIds.length === 1 ? "" : "s"}
                      </a>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Confirm
        open={Boolean(pending)}
        title={pending ? ACTIONS[pending.action].title : ""}
        consequence={pending ? ACTIONS[pending.action].consequence : ""}
        confirmLabel={pending ? ACTIONS[pending.action].verb : ""}
        variant={pending ? ACTIONS[pending.action].variant : "primary"}
        requireNote
        notePlaceholder={pending ? ACTIONS[pending.action].placeholder : ""}
        busy={busy === pending?.exception.id}
        onConfirm={close}
        onCancel={() => setPending(null)}
      >
        {pending && (
          <div className="rounded-lg border border-border bg-sunken p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Severity level={pending.exception.severity} />
              <span className="text-[13px] font-medium">{pending.exception.title}</span>
            </div>
            <p className="mt-1.5 text-[12.5px] text-ink-2">{pending.exception.detail}</p>
          </div>
        )}
      </Confirm>
    </div>
  );
}
