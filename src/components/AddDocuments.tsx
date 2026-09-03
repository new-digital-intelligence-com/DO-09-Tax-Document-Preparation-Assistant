"use client";

import { useCallback, useState } from "react";
import { Icon } from "@/components/icons";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorNote,
  InfoNote,
  Loading,
  Mono,
  SearchInput,
  Tabs,
} from "@/components/ui";

/**
 * Where documents come from.
 *
 * Three sources behind one button, because from the preparer's side they are
 * one act: get the invoice into the workspace. The file on their laptop, the
 * one already in their Drive and the one attached to an email from the vendor
 * are the same document arriving by different roads, and making somebody
 * download from Gmail to their desktop so they can upload it again is work the
 * app should be doing.
 *
 * The Google sources read the account of whoever is using this workspace — not
 * the app owner's. Each person connects their own, and nothing is imported but
 * the files they tick.
 */

type Tab = "upload" | "drive" | "gmail";

type Connection = {
  connected: boolean;
  email?: string;
  can: { driveImport: boolean; gmailImport: boolean; gmailSend: boolean };
  blocked?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  bytes?: number;
  modifiedTime?: string;
  from?: string;
};

type MailAttachment = {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  subject: string;
  from: string;
  date?: string;
};

export function AddDocuments({
  open,
  onClose,
  onUpload,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Files chosen from this computer, handed back for the normal upload path. */
  onUpload: (files: File[]) => void;
  /** Ids that are now on the register and need reading. */
  onImported: (documents: { id: string; filename: string }[], note?: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("upload");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null);
  const [mail, setMail] = useState<MailAttachment[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const loadConnection = useCallback(async () => {
    try {
      const response = await fetch("/api/google/account");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? "The connection could not be read.");
      setConnection(value as Connection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connection could not be read.");
    }
  }, []);

  // Asked for once per opening. Adjusted during render rather than in an
  // effect, which is the same reason as below: an effect fires after the first
  // paint, so the dialog would flash the previous connection state before
  // correcting itself.
  const [asked, setAsked] = useState(false);
  if (open && !asked) {
    setAsked(true);
    loadConnection();
  }
  if (!open && asked) setAsked(false);

  // A new tab starts with nothing picked. Carrying a selection across sources
  // would let somebody import a Drive file they chose while looking at mail.
  // Adjusted during render rather than in an effect: an effect would paint the
  // old tab's selection for a frame before clearing it.
  const [lastTab, setLastTab] = useState<Tab>(tab);
  if (tab !== lastTab) {
    setLastTab(tab);
    if (picked.size > 0) setPicked(new Set());
    if (error) setError("");
  }

  async function search() {
    setBusy(true);
    setError("");
    try {
      const path = tab === "drive" ? "/api/import/drive" : "/api/import/gmail";
      const response = await fetch(`${path}?q=${encodeURIComponent(query)}`);
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Search responded ${response.status}.`);
      if (tab === "drive") setDriveFiles(value.files ?? []);
      else setMail(value.attachments ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function importPicked() {
    setBusy(true);
    setError("");
    try {
      const response =
        tab === "drive"
          ? await fetch("/api/import/drive", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fileIds: Array.from(picked) }),
            })
          : await fetch("/api/import/gmail", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                attachments: (mail ?? []).filter((row) => picked.has(keyOf(row))),
              }),
            });

      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Import responded ${response.status}.`);

      // Failures are reported alongside the successes rather than instead of
      // them: three of four coming across is a different situation from none.
      const failed: { error: string }[] = value.failures ?? [];
      const note = [value.note, failed.length ? failed[0].error : ""].filter(Boolean).join(" ");

      onClose();
      onImported(value.documents ?? [], note || undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The import failed.");
    } finally {
      setBusy(false);
    }
  }

  const needsConnection = tab !== "upload" && !connection?.connected;
  const missingScope =
    tab === "drive"
      ? connection?.connected && !connection.can.driveImport
      : tab === "gmail"
        ? connection?.connected && !connection.can.gmailImport
        : false;

  return (
    <Dialog
      open={open}
      title="Add documents"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        tab !== "upload" && (
          <>
            <span className="mr-auto text-[12px] text-ink-3">
              {picked.size > 0
                ? `${picked.size} selected`
                : "Nothing is imported until you pick it."}
            </span>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={picked.size === 0}
              onClick={importPicked}
            >
              Import {picked.size || ""}
            </Button>
          </>
        )
      }
    >
      <Tabs
        tabs={[
          { id: "upload" as Tab, label: "This computer" },
          { id: "drive" as Tab, label: "Google Drive" },
          { id: "gmail" as Tab, label: "Gmail" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error && <ErrorNote title="That did not work">{error}</ErrorNote>}

      {tab === "upload" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-2">
            PDFs and scans. Each one is read and categorised automatically as soon as it lands —
            you will see it happen.
          </p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong bg-sunken px-6 py-10 text-center transition hover:border-brand">
            <Icon name="upload" className="size-5 text-ink-3" />
            <span className="text-[13px] font-medium">Choose files</span>
            <span className="text-[12px] text-ink-3">PDF, PNG or JPEG</span>
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length === 0) return;
                onClose();
                onUpload(files);
              }}
            />
          </label>
        </div>
      )}

      {tab !== "upload" && (
        <div className="space-y-3">
          {connection === null ? (
            <Loading rows={2} label="Checking the connection…" />
          ) : connection.blocked ? (
            <InfoNote title="Google is not set up for this deployment">{connection.blocked}</InfoNote>
          ) : needsConnection ? (
            <div className="space-y-3 rounded-xl border border-border bg-sunken p-5">
              <p className="text-[13px] font-medium">Connect your Google account</p>
              <p className="text-[12.5px] leading-relaxed text-ink-2">
                This reads <strong>your</strong> Drive and <strong>your</strong> mail, not anybody
                else&apos;s. Only the files you tick are copied into this workspace — nothing is
                swept, and no message body is stored.
              </p>
              {/* A real navigation, not a router push: this route redirects
                  out to Google's consent screen, which is not a page the
                  client router can own. */}
              <a
                href="/api/google/connect"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-white transition hover:opacity-90"
              >
                Connect Google
              </a>
            </div>
          ) : missingScope ? (
            <div className="space-y-3 rounded-xl border border-border bg-sunken p-5">
              <p className="text-[13px] font-medium">
                {connection.email ?? "That account"} is connected, but not for{" "}
                {tab === "drive" ? "Drive" : "Gmail"}
              </p>
              <p className="text-[12.5px] text-ink-2">
                That permission was not granted. Connect again and approve it.
              </p>
              <a
                href="/api/google/connect"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium text-ink-2 transition hover:border-border-strong hover:text-ink"
              >
                Reconnect
              </a>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={
                    tab === "drive"
                      ? "File name…"
                      : "from:vendor, after:2025/01/01, or a vendor name…"
                  }
                  className="flex-1"
                />
                <Button variant="secondary" busy={busy} onClick={search}>
                  Search
                </Button>
              </div>

              <p className="text-[12px] text-ink-3">
                Reading {connection.email ?? "your connected account"}.{" "}
                {tab === "gmail"
                  ? "Only messages with a PDF or scan attached are listed."
                  : "Only PDFs and scans are listed."}
              </p>

              {tab === "drive" && driveFiles !== null && (
                <PickList
                  rows={driveFiles.map((file) => ({
                    key: file.id,
                    title: file.name,
                    meta: [
                      file.modifiedTime?.slice(0, 10),
                      file.bytes ? `${Math.round(file.bytes / 1024)} KB` : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }))}
                  picked={picked}
                  onToggle={toggle(setPicked)}
                  emptyHint="Nothing matching that in your Drive. Try a different name."
                />
              )}

              {tab === "gmail" && mail !== null && (
                <PickList
                  rows={mail.map((row) => ({
                    key: keyOf(row),
                    title: row.filename,
                    meta: [row.from, row.subject, row.date].filter(Boolean).join(" · "),
                  }))}
                  picked={picked}
                  onToggle={toggle(setPicked)}
                  emptyHint="No attachments matched. Gmail search terms work here — try from: or after:."
                />
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function keyOf(row: MailAttachment): string {
  return `${row.messageId}:${row.attachmentId}`;
}

function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>) {
  return (key: string) =>
    set((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
}

function PickList({
  rows,
  picked,
  onToggle,
  emptyHint,
}: {
  rows: { key: string; title: string; meta: string }[];
  picked: Set<string>;
  onToggle: (key: string) => void;
  emptyHint: string;
}) {
  if (rows.length === 0) return <Empty title="Nothing found" hint={emptyHint} />;

  return (
    <ul className="max-h-[46vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
      {rows.map((row) => (
        <li key={row.key}>
          <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition hover:bg-sunken">
            <input
              type="checkbox"
              checked={picked.has(row.key)}
              onChange={() => onToggle(row.key)}
              className="mt-0.5 size-3.5 shrink-0 accent-brand"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium" title={row.title}>
                {row.title}
              </span>
              {row.meta && (
                <span className="block truncate text-[12px] text-ink-3" title={row.meta}>
                  {row.meta}
                </span>
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** The connected account, for screens that need to say which one is in use. */
export function ConnectedAccount({ connection }: { connection: Connection | null }) {
  if (!connection?.connected) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
      <Badge tone="ok" label="connected" dot />
      <Mono>{connection.email ?? "Google account"}</Mono>
    </span>
  );
}
