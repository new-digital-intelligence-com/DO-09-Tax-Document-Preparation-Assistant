"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
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
  NotLoaded,
  Section,
  Stat,
  StatGrid,
  Table,
  Td,
  Toolbar,
  Tr,
} from "@/components/ui";
import { categoryName } from "@/lib/categories";

/**
 * The shared workspace, and the screen you watch a run on.
 *
 * The one thing this page exists to make visible is the difference between a
 * document that was read and one whose answer was already on Drive. That
 * distinction is the entire value of the result cache, and a run that reported
 * "39 processed" without saying how many of them cost a model call would leave
 * nobody able to tell whether the cache worked at all.
 */

type DriveState = "ready" | "needs-consent" | "unconfigured";

type DriveInfo = {
  state: DriveState;
  detail: string;
  folderId: string | null;
  folderUrl: string | null;
  connectUrl: string | null;
  userFolderName?: string;
  input: { id: string; count: number } | null;
  output: { id: string; count: number } | null;
};

type Outcome = {
  docId: string;
  filename: string;
  sha256: string;
  status: "reused" | "computed" | "declined" | "failed";
  detail: string;
  vendor?: string;
  total?: number;
  currency?: string;
  categoryId?: string;
  storedToDrive?: boolean;
};

type RunSummary = {
  driveState: DriveState;
  sync?: { found: number; ingested: number; alreadyHeld: number; skipped: { name: string; reason: string }[] };
  total: number;
  reused: number;
  computed: number;
  declined: number;
  failed: number;
  outcomes: Outcome[];
};

const STATUS: Record<Outcome["status"], { label: string; state: string; hint: string }> = {
  reused: {
    label: "reused",
    state: "accepted",
    hint: "already on Drive — no model call",
  },
  computed: { label: "computed", state: "resolved", hint: "read and saved to Drive" },
  declined: { label: "declined", state: "medium", hint: "not a financial document" },
  failed: { label: "failed", state: "high", hint: "could not be processed" },
};

export function WorkspacePanel() {
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [driveError, setDriveError] = useState("");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmForce, setConfirmForce] = useState(false);

  const loadDrive = useCallback(async () => {
    try {
      const response = await fetch("/api/drive/status");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Drive responded ${response.status}.`);
      setDrive(value as DriveInfo);
      setDriveError("");
    } catch (cause) {
      // An unreadable Drive is an outage to report, never an empty folder.
      setDriveError(cause instanceof Error ? cause.message : "The workspace could not be read.");
    }
  }, []);

  useEffect(() => {
    loadDrive();
  }, [loadDrive]);

  async function run(force: boolean) {
    setBusy(force ? "force" : "run");
    setError("");
    setNote("");
    setConfirmForce(false);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `The run responded ${response.status}.`);
      setSummary(value as RunSummary);
      setNote(
        force
          ? `Re-read all ${value.total} documents, ignoring what Drive already held.`
          : `${value.reused} of ${value.total} came from Drive without a model call.`,
      );
      await loadDrive();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run failed.");
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setError("");
    try {
      const response = await fetch("/api/drive/sync", { method: "POST" });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `The sweep responded ${response.status}.`);
      setNote(
        `${value.found} file(s) in the input folder: ${value.ingested} newly collected, ` +
          `${value.alreadyHeld} already held${value.skipped?.length ? `, ${value.skipped.length} skipped` : ""}.`,
      );
      await loadDrive();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sweep failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && <ErrorNote title="The last action failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <DriveStrip info={drive} error={driveError} />

      <Section
        title="Run the period"
        description="Sweeps the Drive input folder, then works through every document. Anything already answered is read back rather than paid for again."
        actions={
          <Toolbar>
            <Button
              variant="secondary"
              busy={busy === "sync"}
              disabled={Boolean(busy) || drive?.state !== "ready"}
              onClick={sync}
            >
              <Icon name="refresh" className="size-3.5" />
              Sweep Drive
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(busy)}
              onClick={() => setConfirmForce(true)}
            >
              Re-read everything
            </Button>
            <Button variant="primary" busy={busy === "run"} disabled={Boolean(busy)} onClick={() => run(false)}>
              <Icon name="arrow" className="size-3.5" />
              Run
            </Button>
          </Toolbar>
        }
      >
        {busy === "run" || busy === "force" ? (
          <Loading rows={6} label="Working through the period. Documents already on Drive are read back, not re-read…" />
        ) : summary ? (
          <RunResult summary={summary} />
        ) : (
          <NotLoaded what="A run" />
        )}
      </Section>

      <Confirm
        open={confirmForce}
        title="Re-read every document"
        consequence={
          "This ignores everything stored in the Drive output folder and reads all documents " +
          "again, which costs a model call each. Do it when the extraction prompt or the category " +
          "chart has changed and the stored answers are stale in a way the file hashes cannot " +
          "see. For an ordinary run, the plain Run button reuses what is already there."
        }
        confirmLabel="Re-read everything"
        variant="danger"
        busy={busy === "force"}
        onConfirm={() => run(true)}
        onCancel={() => setConfirmForce(false)}
      />
    </div>
  );
}

/**
 * The connection, in its three states.
 *
 * Not two. "Not configured", "configured but nobody has granted access" and
 * "connected" need three different actions, and a boolean sends the operator to
 * fix the wrong one.
 */
function DriveStrip({ info, error }: { info: DriveInfo | null; error: string }) {
  if (error) {
    return (
      <ErrorNote title="The workspace folder could not be read">
        {error} This is a connection problem, not an empty folder — nothing can be said about what
        the workspace holds until it is fixed.
      </ErrorNote>
    );
  }

  if (!info) return <Loading rows={2} label="Checking the workspace…" />;

  if (info.state === "unconfigured") {
    return (
      <InfoNote title="No Drive workspace configured">
        {info.detail} The app runs against its local corpus, and nothing is shared with a Claude
        session.
      </InfoNote>
    );
  }

  if (info.state === "needs-consent") {
    return (
      <div className="rounded-xl border border-warn-line bg-warn-bg p-4">
        <p className="text-[13px] font-medium text-warn-ink">Drive is configured but not connected</p>
        <p className="mt-1 text-[12.5px] text-warn-ink opacity-90">{info.detail}</p>
        <a
          href={info.connectUrl ?? "/api/drive/connect"}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-solid px-3 text-[13px] font-medium text-solid-ink transition hover:bg-solid-hover"
        >
          <Icon name="drive" className="size-3.5" />
          Grant access
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-ok-bg text-ok-ink">
          <Icon name="drive" className="size-4" />
        </span>
        <div>
          <p className="flex items-center gap-2 text-[13px] font-medium">
            Shared workspace
            <Badge state="resolved" label="connected" dot />
          </p>
          <p className="mt-0.5 text-[12px] text-ink-3">
            <Mono>input</Mono> {info.input?.count ?? "—"} file(s) · <Mono>output</Mono>{" "}
            {info.output?.count ?? "—"} stored result(s)
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {info.folderUrl && (
          <a
            href={info.folderUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] text-ink-2 transition hover:border-border-strong hover:text-ink"
          >
            <Icon name="external" className="size-3.5" />
            Open
          </a>
        )}
      </div>
    </div>
  );
}

function RunResult({ summary }: { summary: RunSummary }) {
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat
          label="Reused"
          value={summary.reused}
          tone={summary.reused > 0 ? "ok" : "default"}
          hint="answer read from Drive, no model call"
        />
        <Stat label="Computed" value={summary.computed} hint="read and written back to Drive" />
        <Stat
          label="Declined"
          value={summary.declined}
          tone={summary.declined > 0 ? "warn" : "default"}
          hint="not financial documents"
        />
        <Stat
          label="Failed"
          value={summary.failed}
          tone={summary.failed > 0 ? "crit" : "default"}
        />
      </StatGrid>

      {summary.sync && (
        <InfoNote title="The Drive sweep">
          {summary.sync.found} file(s) in the input folder — {summary.sync.ingested} newly
          collected, {summary.sync.alreadyHeld} already held.
          {summary.sync.skipped.length > 0 && (
            <>
              {" "}
              {summary.sync.skipped.length} skipped:{" "}
              {summary.sync.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}
            </>
          )}
        </InfoNote>
      )}

      {summary.outcomes.length === 0 ? (
        <Empty
          title="No documents in the period"
          hint="Put files in the Drive input folder and sweep, or upload them on the Documents screen."
        />
      ) : (
        <Table
          minWidth={900}
          head={[
            { label: "Document" },
            { label: "Outcome", width: "130px" },
            { label: "What happened" },
            { label: "Vendor", width: "160px" },
            { label: "Amount", align: "right", width: "120px" },
            { label: "Category", width: "170px" },
          ]}
        >
          {summary.outcomes.map((outcome) => {
            const meta = STATUS[outcome.status];
            return (
              <Tr key={outcome.docId}>
                <Td>
                  <span className="block max-w-[260px] truncate font-medium" title={outcome.filename}>
                    {outcome.filename}
                  </span>
                </Td>
                <Td>
                  <Badge state={meta.state} label={meta.label} dot />
                </Td>
                <Td className="text-[12.5px] text-ink-2">{outcome.detail}</Td>
                <Td className="text-ink-2">{outcome.vendor ?? <span className="text-ink-3">—</span>}</Td>
                <Td align="right">
                  <Money amount={outcome.total} currency={outcome.currency ?? "USD"} />
                </Td>
                <Td className="text-ink-2">
                  {outcome.categoryId ? (
                    categoryName(outcome.categoryId)
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
