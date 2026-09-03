"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddDocuments } from "@/components/AddDocuments";
import { Icon } from "@/components/icons";
import {
  Badge,
  Button,
  Confidence,
  Confirm,
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

/** One stage of the pipeline, as it is reported by the server. */
type Step = { label: string; detail?: string; done: boolean };

/**
 * One file's journey through an upload, as the console shows it.
 *
 * `queued` is a distinct stage from `working` on purpose. Documents are read
 * one at a time, so showing five rows all claiming to be in progress would be
 * a picture of something that is not happening — four of them are waiting.
 *
 * `steps` is the part that matters. A badge that says "reading" for thirty
 * seconds tells you no more than a spinner does; the list of what has actually
 * been done — the cache checked, the page read, the vendor and total that came
 * off it, the category chosen, the answer saved — is the difference between
 * watching work happen and waiting for something to stop being stuck.
 */
type Progress = {
  filename: string;
  stage: "uploading" | "queued" | "working" | "done";
  status?: string;
  detail?: string;
  steps: Step[];
};

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
  const [progress, setProgress] = useState<Progress[]>([]);
  const [deleting, setDeleting] = useState<DocumentView | null>(null);
  const [adding, setAdding] = useState(false);
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

  /**
   * Pull in anything dropped straight into the shared Drive folder.
   *
   * Not everything arrives through this screen. Somebody can drag an invoice
   * into the workspace folder from Drive itself, or a colleague can put one
   * there, and before this ran automatically those documents simply never
   * appeared — the sweep lived on a separate screen that a person had to know
   * to visit and remember to press.
   *
   * Fired once per mount and deliberately not awaited by the first render: the
   * table draws from what is already on the register, and anything the sweep
   * finds arrives a moment later. A slow round trip to Drive should never be
   * the reason this screen is blank.
   */
  const swept = useRef(false);
  useEffect(() => {
    if (swept.current) return;
    swept.current = true;

    (async () => {
      try {
        const response = await fetch("/api/drive/sync", { method: "POST" });
        if (!response.ok) return;
        const value = await response.json();
        if ((value.ingested ?? 0) > 0) {
          setNote(
            `${value.ingested} new file${value.ingested === 1 ? "" : "s"} found in the shared Drive ` +
              `folder and added. Use "Read waiting" to read them.`,
          );
          await load();
        }
      } catch {
        // A sweep that could not run leaves the register exactly as it was.
        // Saying so on a screen full of documents would be noise; the Drive
        // connection has its own error path when something is actually broken.
      }
    })();
  }, [load]);

  /**
   * Upload, then walk each document through reading, one at a time.
   *
   * The progress list is the point. A single request that uploaded and read
   * everything before replying meant a minute of nothing — no way to tell
   * whether the files had arrived, where they went, or whether anything was
   * happening at all. Now each file appears the moment its bytes are on
   * Drive, and its row changes as it is read.
   */
  /**
   * Read documents that arrived without going through this screen.
   *
   * Anything uploaded or imported here is read on arrival, so this button only
   * appears when something got onto the register another way — synced straight
   * into the Drive folder, or left behind by a read that failed. It shows the
   * same live progress as an upload rather than a spinner and a count.
   */
  async function readUnread() {
    const waiting = (views ?? []).filter((view) => !view.extraction);
    if (waiting.length === 0) return;

    setBusy("Unread");
    setError("");
    setNote("");
    setProgress(waiting.map((view) => ({ filename: view.doc.filename, stage: "queued", steps: [] })));

    try {
      for (const [index, view] of waiting.entries()) {
        await processOne(view.doc.id, index);
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * Put files on Drive, then walk each one through the pipeline in the open.
   *
   * Two phases, because they answer two different questions. The upload
   * answers "did my file arrive" and has to be fast; the processing answers
   * "what is it" and cannot be. Rolling both into one request meant a minute
   * of silence and no way to tell the two apart.
   *
   * The processing phase reads a stream of steps rather than waiting for a
   * verdict, so what appears on screen is the work itself — the cache being
   * checked, the page being read, the vendor and total that came off it, the
   * category, the save. It runs automatically the moment the upload lands;
   * nobody has to press anything for their documents to be read.
   */
  async function ingest(sources: { file: File; name: string }[]) {
    if (sources.length === 0) return;

    setBusy("Upload");
    setError("");
    setNote("");
    setProgress(sources.map(({ name }) => ({ filename: name, stage: "uploading", steps: [] })));

    try {
      const form = new FormData();
      for (const { file } of sources) form.append("file", file);

      const response = await fetch("/api/documents", { method: "POST", body: form });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Upload responded ${response.status}.`);

      const uploaded: { id: string; filename: string }[] = value.documents ?? [];
      setProgress(uploaded.map((row) => ({ filename: row.filename, stage: "queued", steps: [] })));
      if (value.note) setNote(value.note);

      // The list is refreshed before anything has been read, so the documents
      // appear in the table straight away — the answer to "where did my file
      // go" arrives before the answer to "what is in it".
      await load();

      for (const [index, row] of uploaded.entries()) {
        await processOne(row.id, index);
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload failed.");
      setProgress([]);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /**
   * Documents imported from a person's own Drive, walked through the same steps.
   *
   * An import has already put the bytes in the workspace by the time this is
   * called, so there is no upload phase — but the reading is identical, and so
   * is what a person sees. A file that came from Drive should not be a more
   * mysterious arrival than one dragged off a desktop.
   */
  async function watch(documents: { id: string; filename: string }[], importNote?: string) {
    if (documents.length === 0) {
      if (importNote) setNote(importNote);
      return;
    }

    setBusy("Upload");
    setError("");
    setNote(importNote ?? "");
    setProgress(documents.map((row) => ({ filename: row.filename, stage: "queued", steps: [] })));

    try {
      await load();
      for (const [index, row] of documents.entries()) {
        await processOne(row.id, index);
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  /** Read one document, rendering each step of the pipeline as it is reported. */
  async function processOne(docId: string, index: number) {
    const at = (fn: (entry: Progress) => Progress) =>
      setProgress((current) => current.map((entry, i) => (i === index ? fn(entry) : entry)));

    at((entry) => ({ ...entry, stage: "working", steps: [] }));

    try {
      const response = await fetch(`/api/documents/${docId}/process`, { method: "POST" });
      if (!response.body) throw new Error(`Processing responded ${response.status} with no body.`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      // NDJSON: one object per line, and the last chunk may end mid-line, so
      // the tail is carried over rather than parsed as if it were complete.
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (chunk) buffer += decoder.decode(chunk, { stream: true });

        let cut = buffer.indexOf("\n");
        while (cut !== -1) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf("\n");
          if (!line) continue;

          let event: {
            type?: string;
            label?: string;
            detail?: string;
            terminal?: boolean;
            outcome?: { status?: string; detail?: string };
            error?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue; // A half-written line is not worth failing the upload over.
          }

          if (event.type === "step") {
            at((entry) => ({
              ...entry,
              // Everything before the newest step is finished by definition:
              // the server only reports a stage once the one before it returned.
              steps: [
                ...entry.steps.map((step) => ({ ...step, done: true })),
                { label: event.label ?? "", detail: event.detail, done: Boolean(event.terminal) },
              ],
            }));
          } else if (event.type === "outcome") {
            settled = true;
            at((entry) => ({
              ...entry,
              stage: "done",
              status: event.outcome?.status ?? "computed",
              detail: event.outcome?.detail,
              steps: entry.steps.map((step) => ({ ...step, done: true })),
            }));
          } else if (event.type === "error") {
            settled = true;
            at((entry) => ({
              ...entry,
              stage: "done",
              status: "failed",
              detail: event.error,
              steps: entry.steps.map((step) => ({ ...step, done: true })),
            }));
          }
        }

        if (done) break;
      }

      // A stream that ended without an outcome is a failure, not a success
      // with nothing to say — the connection dropped mid-document.
      if (!settled) {
        at((entry) => ({
          ...entry,
          stage: "done",
          status: "failed",
          detail: "The connection closed before this document finished.",
          steps: entry.steps.map((step) => ({ ...step, done: true })),
        }));
      }
    } catch (cause) {
      at((entry) => ({
        ...entry,
        stage: "done",
        status: "failed",
        detail: cause instanceof Error ? cause.message : "Could not be read.",
        steps: entry.steps.map((step) => ({ ...step, done: true })),
      }));
    }
  }

  /**
   * Delete a document and everything held because of it.
   *
   * The reason is required by the route, not decorated on by the console: a
   * document that leaves a filing period with no record of who removed it or
   * why is a gap in the corpus that cannot be reconstructed later. What goes
   * with it is the register row, the reading, the categorisation, any finding
   * raised only about it, the file on Drive and the cached reading — the last
   * of which is what stops the document walking back in the next time the same
   * file is uploaded.
   */
  async function remove(view: DocumentView, reason: string) {
    setBusy("Delete");
    setError("");
    try {
      const response = await fetch(`/api/documents/${view.doc.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Delete responded ${response.status}.`);

      setDeleting(null);
      if (openId === view.doc.id) setOpenId(null);
      setNote(value.note ?? `${view.doc.filename} was removed.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document could not be removed.");
    } finally {
      setBusy(null);
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

      {progress.length > 0 && (
        <ProcessView progress={progress} onDismiss={() => setProgress([])} />
      )}

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
          {/* One button, three sources. Reading happens on arrival, so there is
              nothing to press afterwards — the buttons that used to say "read
              them" and "sort them" described steps the app now takes itself. */}
          <Button variant="primary" busy={busy === "Upload"} onClick={() => setAdding(true)}>
            <Icon name="upload" className="size-3.5" />
            Add documents
          </Button>
          {counts.unread > 0 && (
            <Button
              variant="secondary"
              busy={busy === "Unread"}
              onClick={readUnread}
              title="Documents that arrived in the Drive folder directly have not been read yet."
            >
              Read {counts.unread} waiting
            </Button>
          )}
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
            <div className="flex items-center gap-2">
              {/* One Open, not two. It prefers the Drive link where there is
                  one, because that is the copy a reviewer can send to somebody
                  else; a localhost URL only works on this machine. */}
              <a
                href={
                  open.doc.sourceRef
                    ? `https://drive.google.com/file/d/${open.doc.sourceRef}/view`
                    : `/api/documents/${open.doc.id}/file`
                }
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] text-ink-2 transition hover:border-border-strong hover:text-ink"
              >
                <Icon name="external" className="size-3.5" />
                Open
              </a>
              {/* Deliberately here and not on the table row. Deleting is the
                  one action in this console that cannot be walked back from
                  the app, so it is reachable only from the pane that is
                  showing you the page you are about to delete. */}
              <Button size="sm" variant="ghost" onClick={() => setDeleting(open)}>
                Delete
              </Button>
            </div>
          )
        }
      >
        {open && <DocumentDetail view={open} currency={currency} />}
      </Drawer>

      <AddDocuments
        open={adding}
        onClose={() => setAdding(false)}
        onUpload={(files) => ingest(files.map((file) => ({ file, name: file.name })))}
        onImported={(documents, importNote) => watch(documents, importNote)}
      />

      <Confirm
        open={Boolean(deleting)}
        title={deleting ? `Delete ${deleting.doc.filename}?` : "Delete this document?"}
        consequence={
          deleting
            ? `Everything held because of this document goes with it: what was read off it, the ` +
              `category it was put in, any flag raised only about it, the file itself on Drive, ` +
              `and the saved reading that would otherwise bring the old figures back if the same ` +
              `file were uploaded again. ` +
              (deleting.extraction?.total != null
                ? `The ${new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: deleting.extraction.currency ?? currency,
                  }).format(deleting.extraction.total)} on it leaves the totals. `
                : "") +
              `Drive keeps the file in its own trash, so it is recoverable there — not from here.`
            : ""
        }
        confirmLabel="Delete it"
        variant="danger"
        busy={busy === "Delete"}
        requireNote
        notePlaceholder="Why this does not belong in the period — duplicate, personal, wrong entity…"
        onConfirm={(reason) => deleting && remove(deleting, reason)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

/**
 * What is happening to the documents just added, while it happens.
 *
 * The file being worked on is expanded and shows every step the server
 * reports; the ones already finished collapse to a single line with their
 * result. That shape is deliberate — a list of ten expanded files is as
 * unreadable as no list at all, and the only one anybody is watching is the
 * one that is moving.
 */
function ProcessView({ progress, onDismiss }: { progress: Progress[]; onDismiss: () => void }) {
  const finished = progress.filter((row) => row.stage === "done").length;
  const allDone = finished === progress.length;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        {!allDone && (
          <span
            aria-hidden
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-brand"
          />
        )}
        <p className="text-[13px] font-medium">
          {allDone
            ? `Finished ${progress.length} document${progress.length === 1 ? "" : "s"}`
            : `Reading ${finished + 1} of ${progress.length}…`}
        </p>
        <span className="ml-auto flex items-center gap-2">
          {!allDone && (
            <span className="text-[12px] text-ink-3">
              This runs on its own — nothing to press.
            </span>
          )}
          {allDone && (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </span>
      </header>

      <ul className="divide-y divide-border">
        {progress.map((row, i) => (
          <li key={`${row.filename}-${i}`} className="px-4 py-2.5">
            <div className="flex items-center gap-2.5 text-[12.5px]">
              <span className="w-[86px] shrink-0">
                <Badge
                  state={row.stage === "done" ? (row.status ?? "computed") : row.stage}
                  label={row.stage === "working" ? "reading" : undefined}
                  dot
                />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium" title={row.filename}>
                {row.filename}
              </span>
              {row.stage === "done" && row.detail && (
                <span className="hidden max-w-[46%] truncate text-ink-3 sm:block" title={row.detail}>
                  {row.detail}
                </span>
              )}
              {row.stage === "queued" && <span className="text-ink-3">waiting its turn</span>}
              {row.stage === "uploading" && (
                <span className="text-ink-3">sending to the Drive workspace</span>
              )}
            </div>

            {row.steps.length > 0 && row.stage !== "done" && (
              <ol className="mt-2 ml-[86px] space-y-1.5 border-l border-border pl-3.5">
                {row.steps.map((step, j) => (
                  <li key={`${step.label}-${j}`} className="flex items-baseline gap-2 text-[12px]">
                    <span
                      aria-hidden
                      className={`-ml-[19px] size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                        step.done ? "bg-ok-ink" : "animate-pulse bg-brand"
                      }`}
                    />
                    <span className={step.done ? "text-ink-3" : "font-medium text-ink"}>
                      {step.label}
                    </span>
                    {step.detail && (
                      <span className="min-w-0 truncate text-ink-3" title={step.detail}>
                        {step.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
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
