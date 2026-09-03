"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Button, ErrorNote, Mono, textareaClass } from "@/components/ui";

/**
 * The assistant panel.
 *
 * What it can do is bounded by its toolset, not by this file: the agent reads
 * the register and can raise nothing, resolve nothing and file nothing. The
 * copy below says so anyway, because a model with no filing tool can still
 * write "I've filed that for you", and a reader who believes it is exactly as
 * badly served as one whose return really was submitted by a bot.
 */

type Turn = { role: "user" | "assistant"; content: string; trace?: string[] };

const STARTERS = [
  "Which documents could not be read?",
  "What is flagged high before I hand this to the accountant?",
  "What does the meals line come to, and why is it not the receipt total?",
];

export function AskPanel() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /**
   * Identity for this sitting, minted here rather than on the server.
   *
   * Everything asked in one session belongs in one transcript, and the server
   * has no way to tell a follow-up question from a fresh conversation — every
   * request looks the same to it. Holding the id on this side is what keeps a
   * morning's questions in one file instead of scattering them across a
   * folder as one file per question.
   */
  const [session] = useState(() => ({
    id: `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
  }));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const next: Turn[] = [...turns, { role: "user", content: question }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
          conversationId: session.id,
          startedAt: session.startedAt,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `The assistant responded ${response.status}.`);
      setTurns([...next, { role: "assistant", content: body.reply, trace: body.trace }]);
      setSaved(body.saved?.filename ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The assistant could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-surface">
        <div className="max-h-[52vh] min-h-[240px] space-y-4 overflow-y-auto p-5">
          {turns.length === 0 && (
            <div className="space-y-4">
              <p className="text-[13px] leading-relaxed text-ink-2">
                It reads the register — documents, categories, the exception list and the drafts. It cannot resolve a flag, change a categorisation or file
                anything; those are yours, in the console.
              </p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    onClick={() => send(starter)}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition hover:border-border-strong hover:text-ink"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, i) => (
            <div key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
              {turn.role === "user" ? (
                <p className="max-w-[80%] rounded-xl rounded-br-sm bg-sunken px-3.5 py-2.5 text-[13px]">
                  {turn.content}
                </p>
              ) : (
                <div className="max-w-[92%] space-y-2">
                  <Markdown text={turn.content} />
                  {turn.trace && turn.trace.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1 text-[11.5px] text-ink-3">
                      <span>Read:</span>
                      {[...new Set(turn.trace)].map((tool) => (
                        <Mono key={tool}>{tool}</Mono>
                      ))}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}

          {busy && <p className="text-[13px] text-ink-3">Reading the register…</p>}

          {/* Said only when it is true. A line that always claimed the
              transcript was kept would be wrong exactly when Drive was
              unreachable, which is the one time it matters. */}
          {!busy && turns.length > 0 && (
            <p className="text-[11.5px] text-ink-3">
              {saved ? (
                <>
                  Saved to your Drive folder as <Mono>conversations/{saved}</Mono>
                </>
              ) : (
                "This conversation could not be saved to Drive. The answers above still stand; only the record of them is missing."
              )}
            </p>
          )}

          <div ref={endRef} />
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
          className="flex items-end gap-2 border-t border-border p-3"
        >
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
            placeholder="Ask about the period…"
            disabled={busy}
            className={textareaClass}
          />
          <Button type="submit" variant="primary" busy={busy} disabled={!draft.trim()}>
            Ask
          </Button>
        </form>
      </div>

      {error && <ErrorNote title="The assistant could not answer">{error}</ErrorNote>}
    </div>
  );
}
