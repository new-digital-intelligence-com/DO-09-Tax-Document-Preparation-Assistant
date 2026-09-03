"use client";

import { useCallback, useEffect, useState } from "react";
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
 * Where a Google account is connected, the pack can go by email from that
 * person's own address rather than from a robot — and the send and the record
 * are one act, so the register can never say a review is under way that nobody
 * was actually told about. Without a connected account it still records the
 * handoff and hands back the text to send by hand.
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
  const [account, setAccount] = useState<{
    connected: boolean;
    email?: string;
    can: { gmailSend: boolean };
  } | null>(null);

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

    // Whether the pack can be emailed from here. A failure to answer means it
    // cannot, which is the safe reading — the button then records the handoff
    // and says plainly that nothing was sent.
    try {
      const response = await fetch("/api/google/account");
      if (response.ok) setAccount(await response.json());
    } catch {
      setAccount(null);
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
   * Hand the pack over — by email where that is possible, by record where it
   * is not.
   *
   * The two are one button rather than two, because from the preparer's side
   * they are one decision: this pack is finished and it is now somebody
   * else's. Whether it travels by Gmail or by copy-and-paste is a fact about
   * the connection, not a choice worth making them make. What changes is only
   * what the console says happened afterwards, and that has to be exact — a
   * person told "sent" whose mail never went is worse off than one told to
   * send it themselves.
   */
  async function handOff(handoffNote: string) {
    if (!pkg) return;
    const canSend = Boolean(account?.connected && account.can.gmailSend);

    setBusy("handoff");
    try {
      const response = await fetch(canSend ? "/api/packages/send" : "/api/packages/handoff", {
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
        canSend
          ? (value.note ?? `Sent to ${value.to}, and the handoff is recorded.`)
          : "Recorded as handed off. No mail was sent — connect a Google account to send it from " +
              "here, or copy the package below and send it yourself.",
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
          {assembleButton}
          <Button
            variant="brand"
            className="ml-auto"
            disabled={!markdown}
            onClick={() => setHanding(true)}
          >
            {account?.connected && account.can.gmailSend
              ? "Email it to the tax manager"
              : "Hand to the tax manager"}
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
        title={
          account?.connected && account.can.gmailSend
            ? "Email this package to a person"
            : "Hand this package to a person"
        }
        consequence={
          (account?.connected && account.can.gmailSend
            ? `The whole pack is emailed to the address below from ${account.email ?? "your connected account"}, ` +
              `and the period is marked handed off. It is marked DRAFT throughout and nothing is filed. `
            : `The pack is recorded as handed to the address below, and the period is marked handed off. ` +
              `Nothing is filed and no mail is sent — connect a Google account to send from here — so ` +
              `you will copy the pack and send it yourself. `) +
          (c.openExceptions > 0
            ? `${c.openExceptions} items are still open; they go across with the pack and the reviewer will have to decide them.`
            : `Nothing is outstanding, but every form in the pack is still a draft awaiting their review.`)
        }
        confirmLabel={
          account?.connected && account.can.gmailSend ? "Send it" : "Record the handoff"
        }
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
