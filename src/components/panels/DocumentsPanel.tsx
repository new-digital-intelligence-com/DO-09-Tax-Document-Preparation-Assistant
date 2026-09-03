"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import {
  Badge,
  Button,
  Confidence,
  Drawer,
  Empty,
  ErrorNote,
  Loading,
  Money,
  Mono,
  Note,
  NotLoaded,
  SearchInput,
  Segmented,
  Table,
  Td,
  Toolbar,
  Tr,
  When,
} from "@/components/ui";
import { categoryName } from "@/lib/categories";
import { effectiveCategoryId, type DocumentView } from "@/lib/types";

type Filter = "all" | "unread" | "unreadable" | "review" | "flagged";

/**
 * The corpus.
 *
 * The column that decides whether this screen is honest is the amount: a
 * document nobody has read yet, and one whose scan could not be read at all,
 * both show an em dash rather than a zero. A row reading $0.00 sits quietly in
 * a column of real figures and contributes nothing to a total anybody checks.
 */
export function DocumentsPanel() {
  const [views, setViews] = useState<DocumentView[] | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/documents");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Documents responded ${response.status}.`);
      setViews(value.documents as DocumentView[]);
      setCurrency(value.period?.currency ?? "USD");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The documents could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(label: string, path: string) {
    setBusy(label);
    setNote("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `${label} responded ${response.status}.`);
      setNote(
        label === "Extract"
          ? `Read ${value.extracted ?? 0} of ${value.run ?? 0}. ${value.unreadable ?? 0} could not be read — they are on the flag list with their filenames, not dropped.`
          : `Sorted ${value.classified ?? 0}. ${value.needsReview ?? 0} need a person's decision.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy("Upload");
    setNote("");
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Upload responded ${response.status}.`);
      setNote(
        value.note ??
          `${value.ingested} added. Run extraction to read them — nothing is read on upload.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload failed.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const counts = useMemo(() => {
    const rows = views ?? [];
    return {
      all: rows.length,
      unread: rows.filter((v) => !v.extraction).length,
      unreadable: rows.filter((v) => v.extraction && v.extraction.status !== "extracted").length,
      review: rows.filter((v) => v.classification?.needsReview).length,
      flagged: rows.filter((v) => v.exceptions.some((e) => e.status === "open")).length,
    };
  }, [views]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (views ?? []).filter((view) => {
      if (filter === "unread" && view.extraction) return false;
      if (filter === "unreadable" && (!view.extraction || view.extraction.status === "extracted")) {
        return false;
      }
      if (filter === "review" && !view.classification?.needsReview) return false;
      if (filter === "flagged" && !view.exceptions.some((e) => e.status === "open")) return false;
      if (!q) return true;
      return [view.doc.filename, view.extraction?.vendor, view.extraction?.invoiceNumber]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [views, filter, query]);

  const open = views?.find((v) => v.doc.id === openId) ?? null;

  if (error && !views) return <ErrorNote title="The documents could not be read">{error}</ErrorNote>;
  if (!views) return <Loading rows={8} label="Reading the corpus…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote title="The last action failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <Toolbar>
        <Segmented
          options={[
            { id: "all" as Filter, label: "All", count: counts.all },
            { id: "unread" as Filter, label: "Not read", count: counts.unread },
            { id: "unreadable" as Filter, label: "Unreadable", count: counts.unreadable },
            { id: "review" as Filter, label: "Needs a decision", count: counts.review },
            { id: "flagged" as Filter, label: "Flagged", count: counts.flagged },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Filename, vendor, invoice number…"
          className="w-full sm:w-64"
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            multiple
            hidden
            onChange={(event) => upload(event.target.files)}
          />
          <Button
            variant="secondary"
            busy={busy === "Upload"}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" className="size-3.5" />
            Add documents
          </Button>
          <Button variant="secondary" busy={busy === "Extract"} onClick={() => run("Extract", "/api/extract")}>
            Read them
          </Button>
          <Button variant="primary" busy={busy === "Categorise"} onClick={() => run("Categorise", "/api/classify")}>
            Sort them
          </Button>
        </div>
      </Toolbar>

      {rows.length === 0 ? (
        counts.all === 0 ? (
          <Empty
            title="No documents collected"
            hint="Run npm run fixtures and npm run seed to load the sample corpus, or add files above."
          />
        ) : (
          <Empty title="Nothing matches that" hint="Clear the filter or the search." />
        )
      ) : (
        <Table
          minWidth={1040}
          head={[
            { label: "Document" },
            { label: "Source", width: "90px" },
            { label: "Vendor", width: "170px" },
            { label: "Date", width: "120px" },
            { label: "Amount", align: "right", width: "120px" },
            { label: "Category", width: "180px" },
            { label: "Read", width: "110px" },
            { label: "Flags", width: "90px" },
          ]}
        >
          {rows.map((view) => {
            const extraction = view.extraction;
            const openFlags = view.exceptions.filter((e) => e.status === "open");
            const foreign =
              extraction?.currency && extraction.currency !== currency ? extraction.currency : null;

            return (
              <Tr key={view.doc.id} onClick={() => setOpenId(view.doc.id)} active={openId === view.doc.id}>
                <Td>
                  <span className="block max-w-[280px] truncate font-medium" title={view.doc.filename}>
                    {view.doc.filename}
                  </span>
                </Td>
                <Td>
                  <Badge state={view.doc.source} />
                </Td>
                <Td className="text-ink-2">
                  {extraction?.vendor ?? <span className="text-ink-3">—</span>}
                </Td>
                <Td className="text-ink-2">
                  <When at={extraction?.issueDate} dateOnly />
                </Td>
                <Td align="right">
                  <Money amount={extraction?.total} currency={extraction?.currency ?? currency} />
                  {foreign && (
                    <span className="ml-1 text-[11px] text-warn-ink" title="Not the period currency">
                      {foreign}
                    </span>
                  )}
                </Td>
                <Td className="text-ink-2">
                  {view.classification ? (
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">
                        {categoryName(effectiveCategoryId(view.classification))}
                      </span>
                      {view.classification.overriddenCategoryId && (
                        <Badge tone="info" label="yours" />
                      )}
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </Td>
                <Td>
                  {!extraction ? (
                    <span className="text-[12px] text-ink-3">not read</span>
                  ) : extraction.status !== "extracted" ? (
                    <Badge state="unreadable" label={extraction.status} dot />
                  ) : (
                    <Confidence value={extraction.confidence} />
                  )}
                </Td>
                <Td>
                  {openFlags.length > 0 ? (
                    <Badge
                      state={openFlags.some((f) => f.severity === "high") ? "high" : "medium"}
                      label={`${openFlags.length}`}
                      dot
                    />
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
      )}

      <Drawer
        open={Boolean(open)}
        title={open?.doc.filename ?? ""}
        subtitle={
          open ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge state={open.doc.source} />
              {open.doc.sourceDetail && <span className="text-ink-3">{open.doc.sourceDetail}</span>}
              <Mono>{open.doc.id}</Mono>
            </span>
          ) : undefined
        }
        onClose={() => setOpenId(null)}
        actions={
          open && (
            <>
              {/* The document on Drive, when the sweep collected it from there.
                  A reviewer who wants to send somebody the source needs the
                  shared link, not a localhost URL that works on one machine. */}
              {open.doc.source === "drive" && open.doc.sourceRef && (
                <a
                  href={`https://drive.google.com/file/d/${open.doc.sourceRef}/view`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] text-ink-2 transition hover:border-border-strong hover:text-ink"
                >
                  <Icon name="drive" className="size-3.5" />
                  Drive
                </a>
              )}
              <a
                href={`/api/documents/${open.doc.id}/file`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] text-ink-2 transition hover:border-border-strong hover:text-ink"
              >
                <Icon name="external" className="size-3.5" />
                Open
              </a>
            </>
          )
        }
      >
        {open && <DocumentDetail view={open} currency={currency} />}
      </Drawer>
    </div>
  );
}

/** The page beside what was read off it — the comparison a reviewer makes. */
function DocumentDetail({ view, currency }: { view: DocumentView; currency: string }) {
  const e = view.extraction;
  const c = view.classification;

  return (
    <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
      <div className="border-border bg-sunken lg:border-r">
        <object
          data={`/api/documents/${view.doc.id}/file`}
          type={view.doc.mimeType || "application/pdf"}
          className="h-[46vh] w-full lg:h-[calc(100dvh-73px)]"
          aria-label={`Preview of ${view.doc.filename}`}
        >
          <p className="p-5 text-[13px] text-ink-2">
            This browser will not display the file inline.{" "}
            <a className="underline" href={`/api/documents/${view.doc.id}/file`} target="_blank" rel="noreferrer">
              Open it in a new tab
            </a>
            .
          </p>
        </object>
      </div>

      <div className="space-y-5 p-5">
        {!e && (
          <NotLoaded what="This document" />
        )}

        {e && e.status !== "extracted" && (
          <ErrorNote title={`Could not be read — ${e.status}`}>
            {e.statusDetail ??
              "Nothing legible was found on the page. It stays in the corpus and on the flag list rather than being dropped, because a document nobody could read is not a document worth nothing."}
          </ErrorNote>
        )}

        {e && e.status === "extracted" && (
          <section className="space-y-2.5">
            <h3 className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">
              What was read
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
              <Row label="Vendor" value={e.vendor} />
              <Row label="Invoice no." value={e.invoiceNumber} />
              <Row label="Issued" value={e.issueDate} />
              <Row label="Due" value={e.dueDate} />
              <Row
                label="Subtotal"
                value={<Money amount={e.subtotal} currency={e.currency ?? currency} />}
              />
              <Row label="Tax" value={<Money amount={e.tax} currency={e.currency ?? currency} />} />
              <Row
                label="Total"
                value={<Money amount={e.total} currency={e.currency ?? currency} />}
              />
              <Row label="Direction" value={e.direction} />
              <Row label="Tax ID" value={e.vendorTaxId} />
              <Row label="Reading confidence" value={<Confidence value={e.confidence} />} />
            </dl>
            {e.notes && <p className="text-[12.5px] text-ink-2">{e.notes}</p>}
          </section>
        )}

        {e && e.lineItems?.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Lines</h3>
            <ul className="space-y-1.5 text-[12.5px]">
              {e.lineItems.map((item, i) => (
                <li key={i} className="flex justify-between gap-3 border-b border-border pb-1.5">
                  <span className="text-ink-2">{item.description}</span>
                  <Money amount={item.amount} currency={e.currency ?? currency} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {c && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Category</h3>
            <p className="text-[13px] font-medium">{categoryName(effectiveCategoryId(c))}</p>
            <p className="text-[12.5px] text-ink-2">{c.rationale}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Confidence value={c.confidence} />
              {c.needsReview && <Badge state="medium" label="needs a decision" dot />}
            </div>
            {c.reviewReason && <p className="text-[12.5px] text-warn-ink">{c.reviewReason}</p>}
          </section>
        )}

        {view.exceptions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Flags</h3>
            {view.exceptions.map((exception) => (
              <div key={exception.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge state={exception.severity} label={exception.severity} dot />
                  <Badge state={exception.status} />
                  <span className="text-[13px] font-medium">{exception.title}</span>
                </div>
                <p className="mt-1.5 text-[12.5px] text-ink-2">{exception.detail}</p>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="tnum text-right">{value || <span className="text-ink-3">—</span>}</dd>
    </>
  );
}
