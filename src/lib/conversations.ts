import "server-only";
import { newId } from "./store";
import { ensureFolder, putFile, workspace } from "./drive";
import type { ChatMessage } from "./agent";

/**
 * Every conversation with the assistant, kept in the person's own workspace.
 *
 * Written as readable Markdown into a `conversations/` folder beside `input`
 * and `output`, not as JSON buried in `state/`. The distinction matters:
 * `state/` is this app's bookkeeping and nobody is expected to open it, while
 * a conversation is something a person wants to read back — six weeks later,
 * from a phone, or after handing the folder to their accountant. A transcript
 * that can only be read by the app that wrote it is a transcript nobody reads.
 *
 * ## Why it is worth keeping at all
 *
 * The answers carry figures. "Meals come to $1,240 and $620 reaches the form
 * line" is a number somebody repeats to their accountant, and when it is
 * queried the useful question is what was actually asked and what was actually
 * answered. Without a transcript that is unrecoverable — the assistant reasons
 * over a register that keeps changing, so asking again next week is not the
 * same as knowing what it said last week.
 *
 * ## One file per conversation, rewritten as it grows
 *
 * Each exchange rewrites the whole file rather than appending a line. Drive
 * has no append, so appending would mean read-modify-write anyway; rewriting
 * is the same cost and cannot produce a half-written file if something fails
 * midway. The id is minted by the browser when a conversation starts, so
 * everything from one sitting lands in one file instead of scattering.
 *
 * ## What it does not do
 *
 * Saving never fails a reply. A person who asked a question and got an answer
 * has been served, and losing the transcript is a smaller harm than an error
 * where the answer should be — so every failure here is swallowed and reported
 * on the response rather than thrown.
 */

const FOLDER = "conversations";

/** `2026-09-03 1742 — what is flagged high.md` — sortable, and readable at a glance. */
function filename(startedAt: string, firstQuestion: string): string {
  const stamp = startedAt.slice(0, 16).replace("T", " ").replace(":", "");
  const subject = firstQuestion
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    // Drive tolerates most characters; a slash is the one that reliably
    // confuses tooling further down, and quotes make shell work miserable.
    .replace(/[/\\:*?"<>|]/g, "")
    .trim();
  return `${stamp}${subject ? ` — ${subject}` : ""}.md`;
}

function render(input: {
  messages: ChatMessage[];
  startedAt: string;
  period: string;
  entity: string;
  actor: string;
}): string {
  const lines: string[] = [
    `# Ask — ${input.period}`,
    "",
    `**Workspace:** ${input.entity}  `,
    `**Started:** ${input.startedAt}  `,
    `**Last updated:** ${new Date().toISOString()}  `,
    `**Asked by:** ${input.actor}`,
    "",
    "> Answers are drafted from the documents collected in this workspace at the moment they",
    "> were asked. The register changes as documents are added and categories are corrected, so",
    "> a figure quoted here is a figure from that moment. Nothing in this conversation was filed",
    "> and nothing in it is tax advice.",
    "",
    "---",
    "",
  ];

  for (const message of input.messages) {
    const text = typeof message.content === "string" ? message.content : "";
    if (!text.trim()) continue;

    if (message.role === "user") {
      lines.push(`### Asked`, "", text.trim(), "");
    } else {
      lines.push(`### Answered`, "", text.trim(), "", "---", "");
    }
  }

  return lines.join("\n");
}

/**
 * Write one conversation to the workspace folder.
 *
 * Returns the file's name on success and `undefined` on any failure, so a
 * caller can say whether the transcript was kept without ever being able to
 * fail the answer it accompanies.
 */
export async function saveConversation(input: {
  id?: string;
  messages: ChatMessage[];
  startedAt?: string;
  period: string;
  entity: string;
  actor: string;
}): Promise<{ id: string; filename: string; folderId: string } | undefined> {
  try {
    const messages = input.messages.filter(
      (m) => typeof m.content === "string" && m.content.trim(),
    );
    if (messages.length === 0) return undefined;

    const id = input.id?.trim() || newId("conv");
    const startedAt = input.startedAt ?? new Date().toISOString();
    const first = messages.find((m) => m.role === "user");
    const name = filename(
      startedAt,
      typeof first?.content === "string" ? first.content : "",
    );

    const folders = await workspace();
    const folderId = await ensureFolder(folders.userFolderId, FOLDER);

    await putFile({
      parentId: folderId,
      name,
      bytes: Buffer.from(render({ ...input, messages, startedAt }), "utf8"),
      mimeType: "text/markdown",
    });

    return { id, filename: name, folderId };
  } catch {
    // Deliberately silent. See the note at the top: an answer already given is
    // worth more than the record of it, and a person who asked a question
    // should never see an error about filing instead of their answer.
    return undefined;
  }
}
