"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  DraftMark,
  ErrorNote,
  Field,
  InfoNote,
  Loading,
  Note,
  NotLoaded,
  Section,
  Stat,
  StatGrid,
  Toolbar,
  When,
  inputClass,
  textareaClass,
} from "@/components/ui";
import type { ReviewPackage } from "@/lib/types";

/**
 * The handoff.
 *
 * The package leads with what is still open rather than with the profit
 * figure, and so does this screen. A pack that opens with "net profit $47,300"
 * invites the reader to trust it; one that opens with "nine items need your
 * decision" tells them what the pack actually is.
 *
 * Handing off files nothing, ever. What it does is name who the pack went to
 * and when, because "it was handed over" with nobody against it is the state
 * where everyone assumes somebody else has it.
 *
 * Nothing is emailed from this screen, deliberately. Sending exists — the
 * `POST /api/packages/send` route is real and the Claude skill uses it — but
 * putting it behind a button here makes a send the path of least resistance,
 * and a package is not a thing to fire off with one click on the way past.
 * From here the pack is downloaded or copied and sent by a person who read it.
 */
export function PackagePanel() {
  const [pkg, setPkg] = useState<ReviewPackage | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [handing, setHanding] = useState(false);
  const [recipient, setRecipient] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/packages");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Packages responded ${response.status}.`);
      const latest = (value.packages as ReviewPackage[])[0];
      if (latest) {
        const detail = await fetch(`/api/packages?id=${latest.id}`).then((r) => r.json());
        setPkg(detail.package as ReviewPackage);
        setMarkdown(detail.markdown ?? "");
        setSummary(detail.package?.summary ?? "");
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The packages could not be read.");
    }

  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function assemble() {
    setBusy("assemble");
    setNote("");
    try {
      const response = await fetch("/api/packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(summary ? { summary } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Assembly responded ${response.status}.`);
      setPkg(value.package as ReviewPackage);
      setMarkdown(value.markdown ?? "");
      setNote("Package assembled. The drafts were regenerated first, so nothing in it is stale.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The package could not be assembled.");
    } finally {
      setBusy(null);
    }
  }

  async function draftSummary() {
    if (!pkg) return;
    setBusy("summary");
    try {
      const response = await fetch("/api/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "package-summary",
          period: pkg.periodId,
          counts: pkg.counts,
          openItems: pkg.openExceptionIds.map((id) => ({ id })),
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Drafting responded ${response.status}.`);
      setSummary(value.text);
      setNote("Summary drafted. Read it before assembling — it is written from the counts, not checked against them.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The summary could not be drafted.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Record that the pack is now somebody else's.
   *
   * It records; it does not send. "It was handed over" with nobody against it
   * is the state where everyone assumes somebody else has it, so the name and
   * the moment are written down — and then a person sends the PDF themselves,
   * having read it.
   */
  async function handOff(handoffNote: string) {
    if (!pkg) return;
    setBusy("handoff");
    try {
      const response = await fetch("/api/packages/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packageId: pkg.id,
          to: recipient.trim() || undefined,
          note: handoffNote,
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Handoff responded ${response.status}.`);
      setHanding(false);
      setNote(
        `Recorded as handed to ${value.period?.handedOffTo ?? (recipient.trim() || "the reviewer")}. ` +
          "Nothing was emailed — download the PDF and send it yourself.",
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff could not be recorded.");
    } finally {
      setBusy(null);
    }
  }

  const assembleButton = (
    <Button variant="primary" busy={busy === "assemble"} onClick={assemble}>
      {pkg ? "Assemble again" : "Assemble the package"}
    </Button>
  );

  if (error && !pkg) {
    return (
      <div className="space-y-4">
        <ErrorNote title="The packages could not be read">{error}</ErrorNote>
        {assembleButton}
      </div>
    );
  }

  if (busy === "assemble" && !pkg) return <Loading rows={6} label="Assembling…" />;

  if (!pkg) {
    return (
      <div className="space-y-4">
        <NotLoaded what="A review package" action={assembleButton} />
        <InfoNote title="What assembling does">
          It regenerates the drafts, then bundles them with the document index and every open item
          into one markdown pack. It files nothing and sends nothing.
        </InfoNote>
      </div>
    );
  }

  const c = pkg.counts;

  return (
    <div className="space-y-6">
      {error && <ErrorNote title="The last action failed">{error}</ErrorNote>}
      {note && <Note>{note}</Note>}

      <StatGrid>
        <Stat
          label="Open items"
          value={c.openExceptions}
          tone={c.openExceptions > 0 ? "brand" : "ok"}
          hint={c.openExceptions ? "these need a decision before filing" : "nothing outstanding"}
        />
        <Stat label="Documents" value={c.documents} hint={`${c.extracted} read, ${c.unreadable} unreadable`} />
        <Stat
          label="Needs a decision"
          value={c.needsReview}
          tone={c.needsReview > 0 ? "warn" : "default"}
        />
      </StatGrid>

      <Section
        title="The pack"
        description="Index, drafts and open items. Every form in it is a draft."
        actions={
          <Toolbar>
            <DraftMark />
            <Badge state={pkg.periodId ? "packaged" : "draft"} label="assembled" />
            <span className="text-[12.5px] text-ink-3">
              <When at={pkg.createdAt} relative />
            </span>
          </Toolbar>
        }
      >
        <Toolbar className="mb-3">
          <Button variant="ghost" busy={busy === "summary"} onClick={draftSummary}>
            Draft the summary
          </Button>
          <CopyButton label="Copy the pack" text={markdown} size="md" />
          {/* An anchor, not a fetch. The browser's own viewer is where a person
              reads a PDF before deciding to send it, and a blob built in
              JavaScript would only get in the way of that. */}
          {markdown && (
            <a
              href={pkg ? `/api/packages/pdf?id=${pkg.id}` : "/api/packages/pdf"}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium text-ink-2 transition hover:border-border-strong hover:text-ink"
            >
              <Icon name="download" className="size-3.5" />
              Download PDF
            </a>
          )}
          {assembleButton}
          <Button
            variant="brand"
            className="ml-auto"
            disabled={!markdown}
            onClick={() => setHanding(true)}
          >
            Hand to the tax manager
          </Button>
        </Toolbar>

        <Field
          label="Summary"
          hint="Written into the pack. Drafting it is optional, and whatever is drafted is yours to correct."
        >
          <textarea
            rows={4}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="One paragraph the reviewer reads first."
            className={textareaClass}
          />
        </Field>

        {markdown ? (
          <div className="mt-4 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-surface p-5">
            <Markdown text={markdown} />
          </div>
        ) : (
          <NotLoaded what="The rendered pack" />
        )}
      </Section>

      <Confirm
        open={handing}
        title="Hand this package to a person"
        consequence={
          `The pack is recorded as handed to the address below, and the period is marked handed ` +
          `off. Nothing is filed and nothing is emailed from here — download the PDF and send it ` +
          `yourself. ` +
          (c.openExceptions > 0
            ? `${c.openExceptions} items are still open; they go across with the pack and the reviewer will have to decide them.`
            : `Nothing is outstanding, but every form in the pack is still a draft awaiting their review.`)
        }
        confirmLabel="Record the handoff"
        variant="brand"
        requireNote
        notePlaceholder="Anything the reviewer should know before they open it."
        busy={busy === "handoff"}
        onConfirm={handOff}
        onCancel={() => setHanding(false)}
      >
        <Field
          label="Recipient"
          hint="Leave blank to use TAX_MANAGER_EMAIL. It cannot be the address that prepared the pack."
        >
          <input
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="tax manager's email"
            className={inputClass}
          />
        </Field>
      </Confirm>
    </div>
  );
}
