import { NextResponse } from "next/server";
import { complete, explainModelError, modelConfigured } from "@/lib/anthropic";
import { getSettings, voicePrompt } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Drafting help for the four places in this app where someone has to write
 * prose: the summary on a review package, the note that closes an exception,
 * the email asking a vendor for a missing invoice, and the note that goes with
 * a handoff.
 *
 * Tool-free on purpose. These are single completions over facts the caller
 * already has on screen; giving the model a tool here would only let it go
 * looking for facts the panel did not ask about, at several times the cost.
 *
 * The whole risk in this endpoint is fabrication. A drafted note that invents a
 * reason does not merely read badly: it closes a finding on grounds nobody ever
 * offered, and the trail then records a decision made against a fiction. So
 * every prompt is built from the request body and nothing else, required facts
 * are checked before the model is called at all, and a thin body comes back as
 * a 400 rather than as fluent invention.
 */

const KINDS = ["package-summary", "exception-note", "vendor-request", "handoff-note"] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Outranks the per-kind brief, and says so, because the brief asks for prose. */
const GUARD = `Ground rules. These outrank everything else you are asked for below.

- Use only the facts given. Do not invent an amount, a date, an invoice number, a
  vendor, a reason, a policy or a name that is not in front of you. Do not soften a
  gap by guessing what was probably meant.
- A blank or short answer is better than a plausible invention. If the facts are too
  thin to write what was asked for, write one sentence naming what is missing, and
  nothing else.
- Never state or imply that anything has been filed, submitted or accepted by a tax
  authority. Nothing in this product files anything. Every form referred to is a
  draft.
- Never state that a discrepancy has been corrected. Findings are reported; a
  correction is something a person did somewhere else, and only if the facts say so.
- Give no opinion on whether something is deductible, whether an asset should be
  capitalised, or what fraction of a cost is business use. Those are the tax
  manager's and they are not yours to hint at.
- Write plain sentences for a busy reader. No greeting, no sign-off unless the brief
  asks for one, no headings, no markdown, no emoji, no exclamation marks.
- Output the text itself and nothing else: no preamble, no "here is", no options to
  choose between, no quotes around it.`;

type Draft = { system: string; prompt: string; maxTokens: number };
type Built = { ok: true; draft: Draft } | { ok: false; error: string };

const bad = (error: string): Built => ({ ok: false, error });
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const scalar = (v: unknown) =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * Rows are rendered field by field rather than summarised here.
 *
 * The panels own their row shapes and will grow fields; a formatter that knew
 * the shape would silently drop whatever it had not been taught, and the
 * dropped field is exactly the one that decides whether the draft is true.
 */
function describeRow(row: unknown): string {
  if (row === null || typeof row !== "object") return scalar(row);
  return Object.entries(row as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${scalar(v)}`)
    .join("; ");
}

const rowList = (rows: unknown) =>
  Array.isArray(rows) ? rows.map((row) => `- ${describeRow(row)}`) : [];

const facts = (lines: (string | false | undefined)[]) => lines.filter(Boolean).join("\n");

function packageSummary(b: Record<string, unknown>): Built {
  const period = text(b.period);
  if (!period) return bad("A period label is required to summarise a package.");

  const counts = b.counts && typeof b.counts === "object" ? describeRow(b.counts) : "";
  const openItems = Array.isArray(b.openItems) ? b.openItems : [];

  return {
    ok: true,
    draft: {
      system: `You write the paragraph a tax manager reads first when a preparation package lands.
Four to six sentences. Cover what was collected, what was categorised, and what is
still open — and lead with what is still open, because that is what decides whether
this pack can be worked from.

Be exact about the unfinished part. Give the number of open items in the same breath
as the totals, never as a footnote: a package reported as ready when part of it was
never resolved is a false record, and it gets signed off on the strength of this
paragraph. Every form in the pack is a draft; say so. Do not recommend a treatment
for anything, and do not say whether any figure is right.`,
      prompt: facts([
        `Period: ${period}`,
        counts && `Counts: ${counts}`,
        openItems.length
          ? `Open items (${openItems.length}), the ones a person still has to deal with:\n${rowList(openItems).join("\n")}`
          : "There are no open items. Say that plainly; do not imply the figures are therefore correct.",
      ]),
      maxTokens: 900,
    },
  };
}

function exceptionNote(b: Record<string, unknown>): Built {
  const title = text(b.title);
  const detail = text(b.detail);
  if (!title) return bad("The finding's title is required.");
  if (!detail) {
    return bad(
      "The finding's detail is required. It carries the figures, and a note written without them " +
        "would have to invent what was wrong.",
    );
  }

  return {
    ok: true,
    draft: {
      system: `You draft the note a preparer will attach when they close a flagged finding. Two or
three sentences, first person, plain.

It has to say what was checked and what was concluded, in terms of the figures in
front of you. It is read six months later by somebody reconstructing what happened,
and the only thing that makes it useful is specificity.

You are drafting, not deciding. If the facts do not say what was done about the
finding, write a note that states what was found and what still needs confirming —
do not assert that it was corrected, chased or agreed.`,
      prompt: facts([
        `Finding: ${title}`,
        `Detail as recorded: ${detail}`,
        text(b.suggestedAction) && `Suggested action on the finding: ${text(b.suggestedAction)}`,
        text(b.outcome)
          ? `What the preparer says happened: ${text(b.outcome)}`
          : "The preparer has not said what happened. Write the note as a record of what was found, not of a resolution.",
      ]),
      maxTokens: 500,
    },
  };
}

function vendorRequest(b: Record<string, unknown>): Built {
  const vendor = text(b.vendor);
  const items = Array.isArray(b.items) ? b.items : [];

  if (!vendor) return bad("A vendor name is required to draft a request.");
  if (items.length === 0) {
    return bad(
      "A document request needs the specific dates and amounts being asked for. Without them the " +
        "draft would have to invent an invoice number, and a request naming an invoice that does " +
        "not exist gets a confused reply and no invoice.",
    );
  }

  return {
    ok: true,
    draft: {
      system: `You draft a short email asking a supplier for copies of invoices that are missing from
our records. Three or four sentences plus the list.

It must be easy to act on: say who we are, say what we are missing with the dates and
amounts exactly as given, and say where to send them. Do not accuse anyone of not
sending them — the usual cause is that they went to somebody outside the finance
inbox. Do not name an invoice number that is not in the facts below. Do not mention
tax, filing or a deadline unless the facts give one.

End with a plain sign-off line reading "Thanks," and nothing after it.`,
      prompt: facts([
        `Supplier: ${vendor}`,
        text(b.entity) && `We are: ${text(b.entity)}`,
        text(b.sendTo) && `Copies should be sent to: ${text(b.sendTo)}`,
        `Missing items, exactly as recorded — reproduce these figures, do not restate them:\n${rowList(items).join("\n")}`,
      ]),
      maxTokens: 700,
    },
  };
}

function handoffNote(b: Record<string, unknown>): Built {
  const to = text(b.to);
  const period = text(b.period);
  if (!to) return bad("The recipient is required: a handoff note is written to a named person.");
  if (!period) return bad("A period label is required.");

  const openItems = Array.isArray(b.openItems) ? b.openItems : [];

  return {
    ok: true,
    draft: {
      system: `You write the short note that accompanies a preparation package handed to a tax
manager for review. Three or four sentences, addressed to them by name.

Say what the pack covers, say plainly that every form in it is a draft and nothing
has been filed, and say what is still open and therefore needs their decision. If
nothing is open, say that and still say the forms are drafts. Do not tell them the
figures are correct and do not recommend a treatment for anything — the review is the
point of sending it.`,
      prompt: facts([
        `Recipient: ${to}`,
        `Period: ${period}`,
        text(b.entity) && `Entity: ${text(b.entity)}`,
        openItems.length
          ? `Open items they will have to decide (${openItems.length}):\n${rowList(openItems).join("\n")}`
          : "Nothing is open. Say so, and still say the forms are drafts awaiting their review.",
      ]),
      maxTokens: 600,
    },
  };
}

function build(kind: Kind, b: Record<string, unknown>): Built {
  switch (kind) {
    case "package-summary":
      return packageSummary(b);
    case "exception-note":
      return exceptionNote(b);
    case "vendor-request":
      return vendorRequest(b);
    case "handoff-note":
      return handoffNote(b);
  }
}

export async function POST(request: Request) {
  if (!modelConfigured()) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set, so nothing can be drafted." },
      { status: 503 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  if (!isKind(payload.kind)) {
    return NextResponse.json(
      { error: `Unknown kind. Expected one of: ${KINDS.join(", ")}.` },
      { status: 400 },
    );
  }

  const built = build(payload.kind, payload);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  try {
    const settings = await getSettings();
    const drafted = await complete({
      system: [built.draft.system, GUARD, voicePrompt(settings)].filter(Boolean).join("\n\n"),
      prompt: built.draft.prompt,
      maxTokens: built.draft.maxTokens,
      // These are reports of fact that a person acts on, and the variety a
      // higher temperature buys is bought with exactly the embellishment the
      // ground rules forbid.
      temperature: 0.2,
    });
    return NextResponse.json({ text: drafted });
  } catch (error) {
    const { message, status } = explainModelError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
