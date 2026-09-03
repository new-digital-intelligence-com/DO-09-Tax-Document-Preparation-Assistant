import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude Haiku 4.5 has a 200K context window. The budgets below are set against
 * that, and against the shape of the work: a tax document is a page or two of
 * dense figures, so the expensive part is the number of documents, not the
 * length of any one of them.
 *
 * PDFs go to the model as `document` content blocks. There is no PDF parsing
 * library in this app on purpose — a text-layer extractor reads a born-digital
 * invoice and returns nothing at all for a scan, and "nothing" is exactly the
 * result that must not be mistaken for "no expenses". Sending the file itself
 * means a scan is read the same way a person reads it, and a genuinely
 * illegible one comes back as `unreadable` rather than as silence.
 */
export const TOKEN_BUDGET = {
  /** Max characters of a single tool result fed back to the model. */
  toolResultChars: 16000,
  /** Max prior messages replayed on each turn. */
  historyMessages: 30,
  /** Max tool-calling rounds before giving up. */
  maxTurns: 12,
  /** Response cap per turn in the chat panel. */
  maxTokens: 8000,
  /** Response cap for one document extraction. */
  extractionTokens: 4000,
  /**
   * Documents sent to the model in one classification call.
   *
   * Six, not twelve. The answer carries a rationale and a list of alternatives
   * per document, and a batch of twelve overran the response budget — the
   * model then returned the array as a truncated string and every document in
   * it came back uncategorised. Half the batch size is two more calls per
   * hundred documents and an answer that fits.
   */
  classifyBatch: 6,
};

/**
 * Hard ceilings from the Messages API, not preferences.
 *
 * A 200K-context model accepts at most 100 pages per PDF, and the whole request
 * must stay under 32 MB. Both are checked before a call rather than after,
 * because the failure otherwise arrives as a 400 with the document already
 * halfway through a batch.
 */
export const PDF_LIMITS = {
  maxPages: 100,
  /** Bytes, before base64 expansion. Left well under 32 MB for the prompt. */
  maxBytes: 20 * 1024 * 1024,
};

function checkApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "The assistant's API key is not set. Copy .env.example to .env.local and " +
        "fill in ANTHROPIC_API_KEY — the README says where to get one.",
    );
  }
}

/** Reads ANTHROPIC_API_KEY from the environment. */
export const anthropic = new Anthropic();

/**
 * Haiku 4.5 predates adaptive thinking and `output_config.effort` — both are
 * rejected on this model, so neither is set anywhere in this app. It is chosen
 * over a larger model because document extraction is high-volume and shallow:
 * a hundred invoices is a hundred calls, and the judgement calls are routed to
 * a person rather than reasoned about.
 */
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

/** Anthropic rejects `max_tokens` omissions and unknown params; keep this shared. */
export async function complete({
  system,
  prompt,
  maxTokens = 2000,
  temperature = 0.2,
}: {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  checkApiKey();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return textOf(response);
}

/**
 * One call over one document file, answered through a forced tool call.
 *
 * The tool is the schema. Asking for JSON in the prompt and parsing the reply
 * puts a fenced code block, an apology, or a trailing comma between the model
 * and a figure that ends up on a tax form; a tool call is validated before it
 * reaches this function. `tool_choice` is set to the tool so there is no path
 * where the model answers in prose instead.
 */
export async function extractFromDocument<T>({
  system,
  instruction,
  file,
  tool,
  maxTokens = TOKEN_BUDGET.extractionTokens,
}: {
  system: string;
  instruction: string;
  file: { data: string; mediaType: "application/pdf" | "image/png" | "image/jpeg"; filename?: string };
  tool: Anthropic.Tool;
  maxTokens?: number;
}): Promise<{ value: T | null; raw: string; stopReason: string | null }> {
  checkApiKey();

  const block: Anthropic.ContentBlockParam =
    file.mediaType === "application/pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: file.data },
          ...(file.filename ? { title: file.filename } : {}),
        }
      : {
          type: "image",
          source: { type: "base64", media_type: file.mediaType, data: file.data },
        };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    // The document block goes before the instruction: the model reads the
    // page, then the question about it.
    messages: [{ role: "user", content: [block, { type: "text", text: instruction }] }],
  });

  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name,
  );

  return {
    value: (call?.input as T) ?? null,
    raw: call ? JSON.stringify(call.input) : textOf(response),
    stopReason: response.stop_reason,
  };
}

/** The same forced-tool shape, over text rather than a file. */
export async function completeStructured<T>({
  system,
  prompt,
  tool,
  maxTokens = 4000,
}: {
  system: string;
  prompt: string;
  tool: Anthropic.Tool;
  maxTokens?: number;
}): Promise<{ value: T | null; raw: string }> {
  checkApiKey();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  });
  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name,
  );
  return { value: (call?.input as T) ?? null, raw: call ? JSON.stringify(call.input) : textOf(response) };
}

export function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Consistent, human error text for model failures. */
export function explainModelError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (/rate_limit|429/i.test(message)) {
    return {
      message: "Rate limited by the model provider. Wait a moment and retry.",
      status: 429,
    };
  }
  if (/authentication|401|api key|ANTHROPIC_API_KEY/i.test(message)) {
    return {
      message: "The assistant's API key is missing or invalid. Check .env.local.",
      status: 401,
    };
  }
  if (/could not process image|unsupported|invalid.*pdf|page.*limit/i.test(message)) {
    return {
      message: `The model could not read that file: ${message}`,
      status: 422,
    };
  }
  return { message, status: 500 };
}

export function modelConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export { checkApiKey };
