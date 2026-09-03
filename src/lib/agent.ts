import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, TOKEN_BUDGET, anthropic, checkApiKey } from "./anthropic";
import { NATIVE_TOOLS, isNativeTool, runNativeTool } from "./native-tools";

export type ChatMessage = Anthropic.MessageParam;

/**
 * The tool-calling loop.
 *
 * The agent's authority is decided by `native-tools.ts` and nothing else. Ten
 * tools reach this loop, every one of them a read. There is no
 * `resolve_exception`, no `override_category`, no `file_return`, no
 * `edit_ledger`, no `assemble_package` and no `hand_off` — not because a prompt
 * forbids them but because they were never written. An instruction is a
 * request; a missing tool is a fact.
 *
 * Anthropic's shape differs from OpenAI-style APIs in three ways that matter:
 * the system prompt is a top-level parameter rather than a message, tool calls
 * arrive as `tool_use` content blocks rather than a `tool_calls` array, and
 * results go back as `tool_result` blocks inside a *user* message.
 */
export async function runAgent({
  system,
  messages,
  actor,
}: {
  system: string;
  messages: ChatMessage[];
  /** Who the conversation is attributed to in the audit trail. */
  actor: string;
}): Promise<{ reply: string; trace: string[] }> {
  checkApiKey();

  const conversation: ChatMessage[] = [...trimHistory(messages)];
  const trace: string[] = [];

  for (let turn = 0; turn < TOKEN_BUDGET.maxTurns; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: TOKEN_BUDGET.maxTokens,
      system,
      messages: conversation,
      tools: NATIVE_TOOLS,
    });

    conversation.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply, trace };
    }

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    trace.push(...calls.map((call) => call.name));

    const blocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
      calls.map(async (call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: truncate(
          await dispatch(call.name, (call.input ?? {}) as Record<string, unknown>, { actor }),
        ),
      })),
    );

    conversation.push({ role: "user", content: blocks });
  }

  return {
    reply:
      "I hit the tool-call limit before finishing, so this answer would be partial and I have not " +
      "given one. Ask something narrower — a single vendor, a single category, or the open flags.",
    trace,
  };
}

/**
 * Fail closed on a name that is not in the toolset.
 *
 * A model can hallucinate a tool, and the one it is most likely to hallucinate
 * here is the one a user just asked for: `file_return`, `resolve_exception`,
 * `fix_ledger`. Each of those comes back as a refusal naming the human route,
 * because an error string would be reported to the user as a malfunction rather
 * than as the design.
 */
async function dispatch(
  name: string,
  input: Record<string, unknown>,
  context: { actor: string },
): Promise<string> {
  if (isNativeTool(name)) return runNativeTool(name, input, context);

  return JSON.stringify({
    error:
      `${name} is not a tool this assistant has, and this is deliberate rather than an outage. ` +
      `Nothing here files, submits or signs anything. Closing or accepting a finding, changing a ` +
      `document's category, editing the ledger and handing off a package are actions a person ` +
      `takes in the console, each one recording a note against their name. Say which screen does ` +
      `it and what they will need to write, and do not describe the action as done.`,
  });
}

/** Long tool output is trimmed rather than dropped, so the model still sees
 *  the shape of the result and can say what it could not see. */
function truncate(text: string): string {
  return text.length > TOKEN_BUDGET.toolResultChars
    ? `${text.slice(0, TOKEN_BUDGET.toolResultChars)}\n...[truncated — say so if this cuts off something the answer depends on]`
    : text;
}

/** A tool result must never lead: it would orphan its assistant tool_use. */
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-TOKEN_BUDGET.historyMessages);
  const start = recent.findIndex((m) => m.role === "user");
  return start <= 0 ? recent : recent.slice(start);
}
