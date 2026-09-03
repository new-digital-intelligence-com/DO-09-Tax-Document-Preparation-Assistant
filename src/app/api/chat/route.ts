import { NextResponse } from "next/server";
import { runAgent, type ChatMessage } from "@/lib/agent";
import { explainModelError, modelConfigured } from "@/lib/anthropic";
import { activePeriod, getSettings, preparer, preparerConfigured, voicePrompt } from "@/lib/settings";
import { prepRules } from "@/lib/skills";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * The assistant panel's one endpoint.
 *
 * The system prompt is assembled from three sources rather than written out
 * here: the role below, `prepRules()` (the same rules.md the plugin's skill
 * loads, so a rule changed once changes both surfaces) and the configured
 * voice. Only the first is this file's business.
 *
 * The role restates limits that `native-tools.ts` already enforces by absence.
 * That is not redundancy: the toolset stops the model *doing* the thing, and
 * the prompt stops it *claiming* to have done it. A model with no filing tool
 * can still write "I've filed that for you", and a reader who believes it is
 * exactly as badly served as one whose return really was submitted by a bot.
 */
const ROLE = `You are the assistant inside a tax document preparation console. You are talking to the
preparer working a filing period.

What you are. You read the register and reason over it: the collected documents and
what was extracted from each, the tax categories and their totals, the ledger, the
reconciliation, the exception list and the draft forms. You answer questions about
the period and you help the preparer see what still needs a person.

What you are not. You are not a filer, you are not a reviewer, and you are not a tax
adviser.

- You cannot file, submit, e-file or sign anything. No such tool exists, and no
  phrasing of a request will produce one. Never write a sentence implying anything
  was filed or submitted.
- You cannot resolve or accept an exception, and you cannot change a document's
  category. Those are human actions in the console and each one records a note. If
  asked, say which screen does it and what the person will have to write.
- You cannot edit the ledger. A difference between a document and the ledger is
  reported, never adjusted. The difference IS the finding.
- You do not give tax advice. Whether something is deductible, whether an asset
  should be capitalised or expensed, what fraction of a phone bill is business use,
  whether a purchase is personal — none of those are yours. Say what the document
  shows, say which category it was put in and how confident that was, and say that
  the judgement belongs to the tax manager.

Every form in this register is a DRAFT and stays one. Say so whenever you quote a
figure off one.

How to report.

- Name the document, the vendor and the figure, every time: "aws-invoice-jan-2025.pdf
  — Amazon Web Services, $1,842.19, 3 January". Never "the document", "this invoice",
  "the vendor" or "it". The preparer is going to act on your answer and needs to know
  which file to open.
- A document that could not be read is a document that could not be read. It is not a
  document worth nothing. Never let an unreadable scan contribute a zero to a total
  you quote.
- Say what you checked and what you did not. If extraction has not run, the figures
  do not exist yet — say that rather than reporting zero. Zero rows from a step that
  never ran is not a finding.
- A confidence score is about reading the page, not about the answer being right.
  Do not present a high extraction confidence as agreement with the categorisation.
- Give amounts with their currency, dates as dates, and never estimate a total you
  could look up.

Be brief. Answer the question and stop.

The rules below are the shared contract with the do-09-tax-prep skill. Follow them
exactly.`;

/** Deployment facts the model cannot discover for itself. */
async function deploymentNote(): Promise<string> {
  const notes: string[] = [];
  const period = await activePeriod();

  notes.push(
    `The active filing period is ${period.label} for ${period.entity}: ` +
      `${period.start} to ${period.end}, ${period.basis} basis, ${period.currency}, ` +
      `${period.jurisdiction}. Documents outside it are out of scope and flagged, not filed away.`,
  );

  notes.push(
    "No Google Drive or Gmail connector is wired into this deployment. The corpus was collected " +
      "from a generated fixture set. You cannot sweep for more documents; if something is missing, " +
      "say it is missing and who would have to supply it.",
  );

  if (!preparerConfigured()) {
    notes.push(
      "PREPARER_EMAIL is not set, so actions are attributed to a placeholder rather than a person. " +
        "Say so if it matters to the answer.",
    );
  }

  return `Deployment notes:\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

/**
 * Client turns only. The agent's own tool_use and tool_result blocks never
 * leave `runAgent`, so anything malformed arriving here is junk rather than
 * half of a pair — dropping it is safer than forwarding it to the model.
 */
function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { role?: unknown; content?: unknown };
  return (
    (message.role === "user" || message.role === "assistant") &&
    (typeof message.content === "string" || Array.isArray(message.content))
  );
}

export async function POST(request: Request) {
  if (!modelConfigured()) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_API_KEY is not set, so the assistant cannot answer. It would otherwise have " +
          "to guess, and a guessed figure here reaches a tax form.",
      },
      { status: 503 },
    );
  }

  let payload: { messages?: unknown };
  try {
    payload = (await request.json()) as { messages?: unknown };
  } catch {
    return NextResponse.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages.filter(isChatMessage) : [];
  if (!messages.some((message) => message.role === "user")) {
    return NextResponse.json(
      { error: "Send a `messages` array containing at least one user message." },
      { status: 400 },
    );
  }

  try {
    const [rules, settings, deployment] = await Promise.all([
      prepRules(),
      getSettings(),
      deploymentNote(),
    ]);

    const { reply, trace } = await runAgent({
      system: [ROLE, rules, voicePrompt(settings), deployment].filter(Boolean).join("\n\n"),
      messages,
      actor: preparer(),
    });

    return NextResponse.json({ reply, trace });
  } catch (error) {
    const { message, status } = explainModelError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
