import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Single source of truth for how tax preparation is handled here.
 *
 * The plugin's skill is the contract. Rather than restating those rules in a
 * second prompt that can drift, the app reads the same file the
 * `do-09-tax-prep` skill loads, so a rule changed once applies to Claude Code,
 * the Claude app and this app's own agent alike.
 */
const RULES_PATH = path.join(
  process.cwd(),
  "plugins/do-09-tax-prep/skills/do-09-tax-prep/references/rules.md",
);

let cached: string | null = null;

/** Strip frontmatter and keep the rules themselves. */
function normalize(markdown: string) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/**
 * The invariants that survive without the plugin directory.
 *
 * This is not a degraded copy kept for form's sake — a deploy that ships only
 * `src/` runs on it, and so does a checkout where the plugin has not been
 * written yet. The three rules below are the whole product, so they are carried
 * verbatim rather than summarised into something vaguer. A prompt that says
 * "be careful about filing" where the rule says "nothing is filed" has already
 * lost the argument it exists to win.
 *
 * The failure-reporting section is here for the same reason. Most of the ways
 * this app can mislead a tax manager are not wrong figures; they are absences
 * presented as facts — a source nobody swept reported as zero documents, a
 * model call that failed reported as a clean quarter, a scan that could not be
 * read quietly missing from a count.
 */
const FALLBACK = [
  "## The three rules",
  "",
  "1. Nothing is filed, submitted or signed. Every form produced is a draft and",
  "   `FormDraft.status` has exactly one possible value: `\"draft\"`. There is no tool that",
  "   files a return, signs one, or marks anything final. A tax manager reviews the package",
  "   and files; you prepare what they review.",
  "",
  "2. Flag, never fix silently. Anything that does not add up on a document is raised as",
  "   an exception with a specific reason. Nothing in this codebase quietly",
  "   adjusts an amount to make a total agree. A subtotal and a tax that do not add up to the",
  "   printed total are reported as all three figures, because the disagreement is the",
  "   finding — correcting it destroys the only evidence that something is wrong.",
  "",
  "3. No tax advice. Deductibility judgement calls — capitalise or expense, the business-use",
  "   fraction of a shared cost, what counts as personal, whether a payment needs a 1099 —",
  "   are routed to the tax manager with the document attached. `TaxCategory.alwaysReview` is",
  "   how that is encoded, and it fires regardless of how confident any answer was. A",
  "   confident answer to a question that is not yours to answer is still not yours to answer.",
  "",
  "## Reporting a failure",
  "",
  "State what was actually read and computed, and nothing else. A figure you did not read is",
  "not a figure you may state, and an omitted field is a better answer than a plausible one.",
  "",
  "A document that could not be read is a finding with a filename on the open-items list. It",
  "is never dropped from a count to make a quarter look complete.",
  "",
  "A source that was not swept returned nothing, and nothing is not zero. This app does not",
  "read anybody's mailbox — the permission is not requested — so never report a count of",
  "documents in one. The same holds for a model call that failed, a file missing from",
  "storage and a folder that was never swept — each is a state to report, never an empty",
  "result presented as a finding.",
  "",
  "When a figure is missing, say it is missing. Never substitute a zero, and never fill a gap",
  "from a filename, a vendor's usual amount, or what a document of that kind normally says.",
  "",
  "Every action, success or failure, is written to the audit trail, and every irreversible one",
  "carries the note the person typed when they took it.",
].join("\n");

/**
 * The rules, from the plugin if it is there and from the fallback if not.
 *
 * Cached after the first read. The rules are a deployment artefact rather than
 * live data, so re-reading them per request would buy nothing; adding the
 * plugin file to a running server needs a restart, which is the same bargain
 * every other file under `plugins/` makes.
 */
export async function prepRules(): Promise<string> {
  if (cached) return cached;
  try {
    cached = normalize(await readFile(RULES_PATH, "utf8"));
  } catch {
    cached = FALLBACK;
  }
  return cached;
}
