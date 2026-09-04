import "server-only";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { record, listAudit } from "../audit";
import { CATEGORIES, categoryName } from "../categories";
import { categoryTotals, listClassifications, overrideCategory } from "../classify";
import {
  documentViews,
  ingest,
  listDocuments,
  sourceBreakdown,
} from "../documents";
import { detect, listExceptions } from "../exceptions";
import { sendMail } from "../gmail";
import { listExtractions } from "../extract";
import { getForm, listForms, renderFormMarkdown } from "../forms";
import {
  personalFileMeta,
  readPersonalFile,
  searchPersonalDrive,
  accountConnection,
} from "../google-account";
import { assemble, getPackage, handOff, listPackages, renderPackageMarkdown } from "../packages";
import { activePeriod, preparer, savePeriod, taxManager } from "../settings";
import { createUser, listUsers } from "../users";
import { processDocument, purgeDocument, syncFromDrive } from "../workspace-sync";
import { effectiveCategoryId } from "../types";
import { withWorkspace } from "../workspace-context";
import { mintUploadTicket } from "./upload-token";

/**
 * The workspace, as tools rather than as instructions.
 *
 * Every one of these wraps a function the web console already calls, which is
 * the entire point: the rules live in code that both surfaces share, not in a
 * prompt one of them has to remember. A model calling `delete_document` gets
 * the same six-step purge and the same required reason as somebody clicking
 * Delete, because it is the same function.
 *
 * ## Why this exists at all
 *
 * The skill previously drove Google Drive directly through the user's own
 * connector, and it could not work. Drive's API has no way to overwrite a
 * file's contents — its update call changes a title and a parent and nothing
 * else — so every register write became read, create a replacement, trash the
 * original: three round trips per collection, with a window where two files
 * shared a name and the register was ambiguous. Adding one receipt took
 * minutes and frequently left the rows unwritten.
 *
 * Here the server holds the credential and does the read-modify-write in one
 * place, atomically, with the audit row in the same step.
 *
 * ## What is deliberately absent
 *
 * There is no `file_return`, no `close_flag`, no `set_category` that does not
 * record who decided. Those absences are the product's authority: a model
 * cannot be argued into an action whose tool does not exist, and an instruction
 * is a request where a missing tool is a fact.
 *
 * `override_category` and `resolve_exception` DO exist, because a person acting
 * through Claude is still a person — but both demand a note naming who decided,
 * and that note goes on the trail beside the model's own answer rather than
 * replacing it.
 */

/** JSON, pretty enough to read in a transcript. */
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * A failure the model should read and explain, not a crash.
 *
 * `isError` is what tells the client this was a tool failure rather than a
 * result; without it a refusal reads as data and gets reported as a finding.
 */
function fail(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Resolve the workspace for this call, then run inside it.
 *
 * `workspaceId` is optional and almost never needed: with one workspace on the
 * instance it is used automatically, which is the common case and saves the
 * model a round trip. With several it is required, because guessing would
 * report one company's figures under another's name — and that is a mistake
 * nothing on screen would reveal.
 */
async function inWorkspace<T>(workspaceId: string | undefined, run: () => Promise<T>): Promise<T> {
  if (workspaceId) return withWorkspace(workspaceId, run);

  const users = await listUsers();
  if (users.length === 1) return withWorkspace(users[0].id, run);
  if (users.length === 0) {
    throw new Error("No workspaces exist yet. Create one with create_workspace.");
  }
  throw new Error(
    `${users.length} workspaces exist, so pass workspaceId — every figure belongs to one ` +
      `person's business. Ask the user which: ${users.map((u) => `${u.name} (${u.id})`).join(", ")}.`,
  );
}

async function guard<T>(what: string, run: () => Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error, what);
  }
}

/** `guard`, scoped to a workspace. Every tool that reads or writes one uses it. */
async function guard2<T>(
  workspaceId: string | undefined,
  what: string,
  run: () => Promise<T>,
) {
  try {
    return ok(await inWorkspace(workspaceId, run));
  } catch (error) {
    return fail(error, what);
  }
}

/** Every tool that touches a workspace accepts this. */
const WORKSPACE_ARG = {
  workspaceId: z
    .string()
    .optional()
    .describe("Omit when only one workspace exists; required when there are several."),
};

export function registerTools(server: McpServer): void {
  /* ── Workspace ──────────────────────────────────────────────────────── */

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "Every workspace in the shared Drive folder, with its entity and document count. " +
        "Call this first: each figure belongs to one person's business, and answering out of " +
        "the wrong workspace reports one company's income as another's. If exactly one comes " +
        "back, use it and say which; if several, ask the user which before doing anything else.",
      inputSchema: {},
    },
    async () =>
      guard("The workspaces could not be listed.", async () => {
        const users = await listUsers();
        return { workspaces: users, count: users.length };
      }),
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create a workspace",
      description: "Start a new workspace for a named person. Confirm the name with them first.",
      inputSchema: { name: z.string().min(1).describe("The person's name.") },
    },
    async ({ name }) =>
      guard("That workspace could not be created.", async () => await createUser(name)),
  );

  /* ── Reading the period ─────────────────────────────────────────────── */

  server.registerTool(
    "period_status",
    {
      title: "Where the period stands",
      description:
        "Counts, money and sources for the active period. Lead any summary with what is still " +
        "open — a count of unresolved items — before quoting a figure. A money field of null " +
        "means the step that produces it has not run; null is not zero.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) =>
      guard2(workspaceId, "The status could not be read.", async () => {
        const period = await activePeriod();
        const [docs, extractions, classifications, exceptions, forms, packages, sources] =
          await Promise.all([
            listDocuments({ periodId: period.id }),
            listExtractions(period.id),
            listClassifications(period.id),
            listExceptions({ periodId: period.id }),
            listForms(period.id),
            listPackages(period.id),
            sourceBreakdown(period.id),
          ]);

        const open = exceptions.filter((e) => e.status === "open");
        return {
          period,
          counts: {
            documents: docs.length,
            read: extractions.filter((e) => e.status === "extracted").length,
            unreadable: extractions.filter((e) => e.status === "unreadable").length,
            notReadYet: docs.length - extractions.length,
            categorised: classifications.length,
            needsADecision: classifications.filter((c) => c.needsReview).length,
          },
          openItems: {
            total: open.length,
            high: open.filter((e) => e.severity === "high").length,
            medium: open.filter((e) => e.severity === "medium").length,
            low: open.filter((e) => e.severity === "low").length,
          },
          forms: forms.map((f) => ({ formId: f.formId, generatedAt: f.generatedAt })),
          packages: packages.map((p) => ({ id: p.id, createdAt: p.createdAt })),
          sources,
          nothingIsFiled: "Every form here is a draft. No return has been submitted or signed.",
        };
      }),
  );

  server.registerTool(
    "list_documents",
    {
      title: "The collected documents",
      description:
        "Every document with what was read off it and the category it landed in. A document " +
        "with no extraction has not been read yet — that is different from one with nothing " +
        "on it. Quote the filename, the vendor and the figure; never 'the invoice'.",
      inputSchema: {
        ...WORKSPACE_ARG,
        flaggedOnly: z.boolean().optional().describe("Only documents with an open finding."),
        limit: z.number().optional().describe("Default 100."),
      },
    },
    async ({ workspaceId, flaggedOnly, limit }) =>
      guard2(workspaceId, "The documents could not be read.", async () => {
        const period = await activePeriod();
        let views = await documentViews(period.id);
        if (flaggedOnly) views = views.filter((v) => v.exceptions.some((e) => e.status === "open"));
        return {
          total: views.length,
          documents: views.slice(0, limit ?? 100).map((v) => ({
            id: v.doc.id,
            filename: v.doc.filename,
            source: v.doc.source,
            vendor: v.extraction?.vendor ?? null,
            issueDate: v.extraction?.issueDate ?? null,
            total: v.extraction?.total ?? null,
            currency: v.extraction?.currency ?? null,
            status: v.extraction?.status ?? "not read yet",
            category: v.classification ? categoryName(effectiveCategoryId(v.classification)) : null,
            needsADecision: v.classification?.needsReview ?? null,
            openFindings: v.exceptions.filter((e) => e.status === "open").length,
          })),
        };
      }),
  );

  server.registerTool(
    "search_documents",
    {
      title: "Find documents by free text",
      description:
        "Search the collected documents — vendor, filename, invoice number, line items, notes, " +
        "category, rationale. Matches on ANY word, not the phrase. This answers 'do I have an X' " +
        "questions; an empty result is a complete answer meaning nothing matching was collected. " +
        "Never go looking anywhere else for it.",
      inputSchema: { ...WORKSPACE_ARG, query: z.string(), limit: z.number().optional() },
    },
    async ({ workspaceId, query, limit }) =>
      guard2(workspaceId, "The search failed.", async () => {
        const period = await activePeriod();
        const views = await documentViews(period.id);
        const terms = Array.from(
          new Set(query.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2)),
        );
        const needles = terms.length ? terms : [query.toLowerCase()];

        const scored = views
          .map((v) => {
            const categoryId = v.classification ? effectiveCategoryId(v.classification) : "";
            const hay = [
              v.doc.filename,
              v.doc.sourceDetail,
              v.extraction?.vendor,
              v.extraction?.invoiceNumber,
              v.extraction?.vendorTaxId,
              v.extraction?.notes,
              ...(v.extraction?.lineItems ?? []).map((l) => l.description),
              categoryId && categoryName(categoryId),
              v.classification?.rationale,
            ]
              .filter(Boolean)
              .join(" \n ")
              .toLowerCase();
            return { v, matched: needles.filter((n) => hay.includes(n)) };
          })
          .filter((r) => r.matched.length)
          .sort((a, b) => b.matched.length - a.matched.length);

        return {
          searchedFor: needles,
          total: scored.length,
          documents: scored.slice(0, limit ?? 25).map((r) => ({
            id: r.v.doc.id,
            filename: r.v.doc.filename,
            vendor: r.v.extraction?.vendor ?? null,
            issueDate: r.v.extraction?.issueDate ?? null,
            total: r.v.extraction?.total ?? null,
            currency: r.v.extraction?.currency ?? null,
            matchedTerms: r.matched,
          })),
        };
      }),
  );

  server.registerTool(
    "get_document",
    {
      title: "One document in full",
      description: "The record, the full extraction with line items, the category, and its findings.",
      inputSchema: { ...WORKSPACE_ARG, docId: z.string() },
    },
    async ({ workspaceId, docId }) =>
      guard2(workspaceId, "That document could not be read.", async () => {
        const period = await activePeriod();
        const view = (await documentViews(period.id)).find((v) => v.doc.id === docId);
        if (!view) throw new Error(`No document ${docId} in this period.`);
        return view;
      }),
  );

  /* ── Adding documents ───────────────────────────────────────────────── */

  server.registerTool(
    "upload_document",
    {
      title: "Add a file — the fast path",
      description:
        "USE THIS for any file on disk, which is every attachment. Returns a URL. Run exactly " +
        "one command:\n\n" +
        "    curl -sS -X PUT --data-binary @<path> \"<uploadUrl>\"\n\n" +
        "The bytes go straight from your sandbox to the server — they never pass through the " +
        "conversation — and curl prints the finished result: registered, read and categorised. " +
        "Report that. Do not base64 the file, do not read it first, do not call add_document.",
      inputSchema: {
        ...WORKSPACE_ARG,
        filename: z.string().describe("The original filename, unchanged."),
        mimeType: z.string().optional().describe("Defaults to application/pdf."),
      },
    },
    async ({ workspaceId, filename, mimeType }) =>
      guard2(workspaceId, "An upload URL could not be issued.", async () => {
        const users = await listUsers();
        const resolved = workspaceId ?? (users.length === 1 ? users[0].id : undefined);
        if (!resolved) throw new Error("Pass workspaceId — several workspaces exist.");

        const ticket = mintUploadTicket({
          workspaceId: resolved,
          filename,
          mimeType: mimeType || "application/pdf",
        });
        const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";

        return {
          uploadUrl: `${base}/api/upload/${ticket}`,
          run: `curl -sS -X PUT --data-binary @<path-to-file> "${base}/api/upload/${ticket}"`,
          expiresInMinutes: 10,
          then: "curl prints the result. Report it. Nothing else to call.",
        };
      }),
  );

  server.registerTool(
    "add_document",
    {
      title: "Add a document from bytes you already hold",
      description:
        "Only for content you can already produce as text — a file you generated yourself. " +
        "**For anything on disk, including every attachment, use upload_document instead**: " +
        "base64 of a real file is thousands of tokens you would have to type out, and running " +
        "`base64` in a shell does not help because its output cannot be moved into this argument.",
      inputSchema: {
        ...WORKSPACE_ARG,
        filename: z.string(),
        contentBase64: z.string().min(1).describe("The file's bytes, base64 encoded."),
        mimeType: z.string().optional().describe("Defaults to application/pdf."),
      },
    },
    async ({ workspaceId, filename, contentBase64, mimeType }) =>
      guard2(workspaceId, "That document could not be added.", async () => {
        const bytes = Buffer.from(contentBase64, "base64");
        if (bytes.length === 0) {
          throw new Error(
            "contentBase64 decoded to nothing. If the file is on disk, use upload_document — " +
              "it takes a path and needs no encoding.",
          );
        }

        const period = await activePeriod();
        const { doc, duplicateOf } = await ingest({
          filename,
          bytes,
          mimeType: mimeType || "application/pdf",
          source: "upload",
          sourceDetail: "Added through Claude",
          periodId: period.id,
          actor: preparer(),
        });

        const outcome = await processDocument(doc.id, { actor: preparer() });
        return {
          document: { id: doc.id, filename: doc.filename, bytes: doc.bytes, sha256: doc.sha256 },
          duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : null,
          read: outcome,
        };
      }),
  );

  server.registerTool(
    "search_my_drive",
    {
      title: "Search the user's own Drive",
      description:
        "Find PDFs and scans in the connected person's own Drive, to import. Only when they ask " +
        "to add documents — never to answer a question about what they have, which is what " +
        "search_documents is for.",
      inputSchema: { ...WORKSPACE_ARG, query: z.string().optional() },
    },
    async ({ workspaceId, query }) =>
      guard2(workspaceId, "That Drive could not be searched.", async () => ({
        files: await searchPersonalDrive(query ?? ""),
      })),
  );

  server.registerTool(
    "import_from_drive",
    {
      title: "Import files from the user's Drive",
      description:
        "Copy chosen files out of the person's own Drive into the workspace, then read and " +
        "categorise each. Only the ids they picked. The bytes never pass through you.",
      inputSchema: { ...WORKSPACE_ARG, fileIds: z.array(z.string()).min(1) },
    },
    async ({ workspaceId, fileIds }) =>
      guard2(workspaceId, "The import failed.", async () => {
        const period = await activePeriod();
        const actor = preparer();
        const added = [];
        const failures = [];

        for (const fileId of fileIds) {
          try {
            const [meta, bytes] = await Promise.all([
              personalFileMeta(fileId),
              readPersonalFile(fileId),
            ]);
            const { doc } = await ingest({
              filename: meta.name || `${fileId}.pdf`,
              bytes,
              mimeType: meta.mimeType || "application/pdf",
              source: "drive",
              sourceDetail: meta.from ? `Google Drive · ${meta.from}` : "Google Drive",
              periodId: period.id,
              actor,
            });
            added.push({ id: doc.id, filename: doc.filename, read: await processDocument(doc.id, { actor }) });
          } catch (error) {
            // One unreadable file does not cancel the rest: they picked several,
            // and failing all of them because of one is worse than saying which.
            failures.push({
              fileId,
              error: error instanceof Error ? error.message : "Could not be imported.",
            });
          }
        }
        return { imported: added.length, documents: added, failures };
      }),
  );

  server.registerTool(
    "sync_drive_folder",
    {
      title: "Pull in anything dropped into the workspace folder",
      description:
        "Register any file sitting in the workspace's input folder that is not yet on the " +
        "register — for documents somebody dragged in directly.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) => guard2(workspaceId, "The sweep failed.", async () => await syncFromDrive(preparer())),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document and everything held because of it",
      description:
        "Removes the row, the reading, the categorisation, findings raised only about it, the " +
        "file itself and its cached reading. The reason is required and goes on the audit trail. " +
        "Confirm with the person before calling this — it is the one action here that cannot be " +
        "undone from the console.",
      inputSchema: {
        ...WORKSPACE_ARG,
        docId: z.string(),
        reason: z.string().min(1).describe("Why. Written to the trail."),
      },
    },
    async ({ workspaceId, docId, reason }) =>
      guard2(workspaceId, "That document could not be deleted.", async () =>
        await purgeDocument(docId, preparer(), reason),
      ),
  );

  /* ── Categories, findings, forms ────────────────────────────────────── */

  server.registerTool(
    "category_totals",
    {
      title: "Totals by tax category",
      description:
        "`recorded` is what the documents add up to; `deductible` is what reaches the return " +
        "after the statutory fraction. They differ for meals and for anything capitalised, and " +
        "that difference is a rule, not a discrepancy. Documents in another currency are counted " +
        "and listed but never added into a total in a different one.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) =>
      guard2(workspaceId, "The totals could not be read.", async () => {
        const period = await activePeriod();
        return { period: period.label, currency: period.currency, categories: await categoryTotals(period.id) };
      }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "The chart of tax categories",
      description:
        "Every category, its form line, what belongs in it, the fraction that reaches the line, " +
        "and whether it always goes to a human. Read this before explaining why a figure was " +
        "adjusted or why something was flagged.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async () =>
      ok(
        CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          formLine: c.formLine,
          description: c.description,
          reachesTheLineAt:
            c.deductiblePct === undefined ? "100%" : `${Math.round(c.deductiblePct * 100)}%`,
          alwaysReview: Boolean(c.alwaysReview),
        })),
      ),
  );

  server.registerTool(
    "list_findings",
    {
      title: "Everything flagged for a person",
      description:
        "Read `detail` verbatim — it carries the actual figures — then `suggestedAction`. " +
        "Closing one is a human decision; see resolve_finding.",
      inputSchema: {
        ...WORKSPACE_ARG,
        status: z.enum(["open", "resolved", "accepted"]).optional(),
        severity: z.enum(["high", "medium", "low"]).optional(),
        docId: z.string().optional(),
      },
    },
    async ({ workspaceId, status, severity, docId }) =>
      guard2(workspaceId, "The findings could not be read.", async () => {
        const period = await activePeriod();
        let rows = await listExceptions({ periodId: period.id, docId });
        if (status) rows = rows.filter((r) => r.status === status);
        if (severity) rows = rows.filter((r) => r.severity === severity);
        return { total: rows.length, findings: rows };
      }),
  );

  server.registerTool(
    "detect_findings",
    {
      title: "Re-run detection",
      description:
        "Recompute the findings. Idempotent and safe to re-run: a reviewer's status and note " +
        "survive, the wording and figures are refreshed, and findings that no longer apply are " +
        "dropped with that drop logged.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) =>
      guard2(workspaceId, "Detection failed.", async () => {
        const period = await activePeriod();
        return await detect(period.id, preparer());
      }),
  );

  server.registerTool(
    "draft_forms",
    {
      title: "Draft the tax forms",
      description:
        "Schedule C, the 1099-NEC summary and the 1040-ES worksheet, computed from the " +
        "categorised documents. Every adjusted line says why. **Say the word draft whenever you " +
        "quote a figure off one** — nothing here is filed or filable.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) =>
      guard2(workspaceId, "The drafts could not be generated.", async () => {
        const period = await activePeriod();
        const forms = await listForms(period.id);
        return {
          forms: forms.map((f) => ({
            formId: f.formId,
            formName: f.formName,
            generatedAt: f.generatedAt,
            status: f.status,
            lines: f.lines,
            totals: f.totals,
          })),
          disclaimer: "Every one of these is a draft. Nothing has been filed, submitted or signed.",
        };
      }),
  );

  server.registerTool(
    "get_form",
    {
      title: "One draft form, rendered",
      description: "The form as markdown, with every line and the note saying why any was adjusted.",
      inputSchema: { ...WORKSPACE_ARG, formId: z.enum(["schedule-c", "1099-nec-summary", "1040-es-worksheet"]) },
    },
    async ({ workspaceId, formId }) =>
      guard2(workspaceId, "That form could not be read.", async () => {
        const period = await activePeriod();
        const form = await getForm(period.id, formId);
        if (!form) throw new Error(`No ${formId} draft. Run draft_forms first.`);
        return { form, markdown: renderFormMarkdown(form) };
      }),
  );

  /* ── Package ────────────────────────────────────────────────────────── */

  server.registerTool(
    "assemble_package",
    {
      title: "Assemble the review package",
      description:
        "Regenerates the drafts, then builds the pack: open items first, then the totals, then " +
        "the document index. It opens with what needs a decision because a pack that opens with " +
        "a profit figure invites somebody to act on it.",
      inputSchema: { ...WORKSPACE_ARG, summary: z.string().optional().describe("One paragraph the reviewer reads first.") },
    },
    async ({ workspaceId, summary }) =>
      guard2(workspaceId, "The package could not be assembled.", async () => {
        const period = await activePeriod();
        const pkg = await assemble(period.id, preparer(), { summary });
        const forms = await listForms(period.id);
        return { package: pkg, markdown: renderPackageMarkdown(pkg, forms) };
      }),
  );

  server.registerTool(
    "hand_off_package",
    {
      title: "Record the handoff",
      description:
        "Names who the pack went to and marks the period handed off. It sends nothing and files " +
        "nothing. The recipient may not be the address that prepared it — a second person " +
        "reviewing before anything is filed is the whole point.",
      inputSchema: {
        ...WORKSPACE_ARG,
        packageId: z.string(),
        to: z.string().optional().describe("Defaults to the configured tax manager."),
        note: z.string().min(1).describe("What the reviewer should know. Required."),
      },
    },
    async ({ workspaceId, packageId, to, note }) =>
      guard2(workspaceId, "The handoff could not be recorded.", async () => {
        const recipient = to ?? taxManager();
        return await handOff({ packageId, actor: preparer(), to: recipient, note });
      }),
  );

  server.registerTool(
    "send_package",
    {
      title: "Email the package to the reviewer",
      description:
        "Sends the pack from the workspace owner's own address and records the handoff in the " +
        "same act — so the register can never say a review is under way that nobody was told " +
        "about. Requires their Google account to be connected with send permission; " +
        "connection_status says whether it is. **Confirm the recipient with the user first.** " +
        "There is no draft mode: the tax manager receives whatever you send, so never call this " +
        "to check that it works.",
      inputSchema: {
        ...WORKSPACE_ARG,
        packageId: z.string(),
        to: z.string().optional().describe("Defaults to the configured tax manager."),
        cc: z.string().optional(),
        note: z.string().min(1).describe("What the reviewer should know. Required."),
      },
    },
    async ({ workspaceId, packageId, to, cc, note }) =>
      guard2(workspaceId, "The package could not be sent.", async () => {
        const connection = await accountConnection();
        if (!connection.connected || !connection.can.gmailSend) {
          throw new Error(
            connection.connected
              ? "That account is connected but was not granted permission to send mail. " +
                "Reconnect it from the console and approve sending."
              : "No Google account is connected to this workspace, so there is no address to " +
                "send from. Connect one from the console first.",
          );
        }

        const pkg = await getPackage(packageId);
        if (!pkg) throw new Error(`No package with id ${packageId}.`);

        const recipient = (to ?? taxManager()).trim();
        if (!recipient || recipient.includes("example.invalid")) {
          throw new Error("No recipient. A package with nobody named is one nobody is waiting for.");
        }
        if (recipient.toLowerCase() === preparer().trim().toLowerCase()) {
          throw new Error(
            "That is the address the pack was prepared under. A second person reviewing it " +
              "before anything is filed is the whole point of the handoff.",
          );
        }

        const period = await activePeriod();
        const forms = await listForms(period.id);
        const body = [
          `${period.label} for ${period.entity} is assembled and ready for your review.`,
          "",
          "Everything in this package is a DRAFT. Nothing has been filed, submitted or signed,",
          "and nothing in this system can do any of those things.",
          "",
          `${pkg.counts.documents} documents collected · ${pkg.counts.extracted} read · ` +
            `${pkg.counts.needsReview} need a decision · ${pkg.counts.openExceptions} items still open.`,
          `\nFrom ${preparer()}:\n${note}`,
          "",
          "----",
          "",
          pkg.markdown ?? renderPackageMarkdown(pkg, forms),
        ].join("\n");

        // The mail goes first. It is the part that can fail for reasons outside
        // this app, and a handoff recorded against a message that never sent
        // leaves the register claiming a review nobody was told about.
        const sent = await sendMail({
          to: recipient,
          cc,
          subject: `DRAFT for review — ${period.label} ${period.entity}`,
          body,
        });
        const handed = await handOff({ packageId, actor: preparer(), to: recipient, note });

        await record({
          actor: preparer(),
          action: "package.emailed",
          subject: pkg.id,
          result: "ok",
          periodId: pkg.periodId,
          detail:
            `The ${period.label} package was emailed to ${recipient}` +
            `${cc ? ` (cc ${cc})` : ""} from ${connection.email ?? "the connected account"} as ` +
            `Gmail message ${sent.id}. It is marked DRAFT throughout and nothing was filed.`,
        });

        return {
          sent: true,
          to: recipient,
          from: connection.email,
          messageId: sent.id,
          package: handed,
        };
      }),
  );

  /* ── History ────────────────────────────────────────────────────────── */

  server.registerTool(
    "read_audit",
    {
      title: "The audit trail",
      description:
        "Who did what, when, and the reason they wrote. `query` searches the wording, which is " +
        "the ONLY way to trace a document that has since been deleted — its filename lives in " +
        "the entry's text. Search here before telling anybody no record exists.",
      inputSchema: {
        ...WORKSPACE_ARG,
        query: z.string().optional().describe("Free text: a filename, a vendor, an amount."),
        docId: z.string().optional(),
        action: z.string().optional(),
        limit: z.number().optional().describe("Default 40, newest first."),
      },
    },
    async ({ workspaceId, query, docId, action, limit }) =>
      guard2(workspaceId, "The trail could not be read.", async () => {
        const period = await activePeriod();
        return {
          events: await listAudit({
            periodId: period.id,
            query,
            docId,
            action,
            limit: limit ?? 40,
          }),
        };
      }),
  );

  /* ── Human decisions, recorded as human decisions ───────────────────── */

  server.registerTool(
    "resolve_finding",
    {
      title: "Close a finding on a person's instruction",
      description:
        "Only when the person you are talking to has told you what they decided. `resolved` " +
        "means the underlying problem was fixed; `accepted` means they looked and it is fine. " +
        "Those are different claims about the period and the note must say which and why. Never " +
        "close one on your own judgement.",
      inputSchema: {
        ...WORKSPACE_ARG,
        id: z.string(),
        note: z.string().min(1).describe("What they found or decided, in their words."),
        accept: z.boolean().optional().describe("True to accept rather than resolve."),
      },
    },
    async ({ workspaceId, id, note, accept }) =>
      guard2(workspaceId, "That finding could not be closed.", async () => {
        const { resolveException } = await import("../exceptions");
        return await resolveException({ id, actor: preparer(), note, accept });
      }),
  );

  server.registerTool(
    "override_category",
    {
      title: "Record a person's category correction",
      description:
        "Only on their instruction. Your answer is kept beside theirs rather than replaced, and " +
        "the note records who decided. Never call this to correct yourself — recategorise by " +
        "re-reading the document instead.",
      inputSchema: {
        ...WORKSPACE_ARG,
        docId: z.string(),
        categoryId: z.string(),
        note: z.string().min(1).describe("Why they changed it."),
      },
    },
    async ({ workspaceId, docId, categoryId, note }) =>
      guard2(workspaceId, "That category could not be changed.", async () =>
        await overrideCategory({ docId, categoryId, actor: preparer(), note }),
      ),
  );

  /* ── Connection state ───────────────────────────────────────────────── */

  server.registerTool(
    "connection_status",
    {
      title: "What this workspace can reach",
      description:
        "Whether a Google account is connected for importing and sending, and which permissions " +
        "it actually carries.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async ({ workspaceId }) =>
      guard2(workspaceId, "The connection could not be read.", async () => ({
        account: await accountConnection(),
        preparer: preparer(),
        taxManager: taxManager(),
      })),
  );

  /* ── The period itself ──────────────────────────────────────────────── */

  server.registerTool(
    "update_period",
    {
      title: "Rename or re-date the period",
      description:
        "What the period is called, who it is for, and what it covers — printed on every draft " +
        "form. The dates constrain nothing: no document is rejected or flagged for falling " +
        "outside them, and the period's id never changes.",
      inputSchema: {
        ...WORKSPACE_ARG,
        label: z.string().optional(),
        entity: z.string().optional(),
        start: z.string().optional().describe("YYYY-MM-DD"),
        end: z.string().optional().describe("YYYY-MM-DD"),
        currency: z.string().optional(),
        basis: z.enum(["cash", "accrual"]).optional(),
      },
    },
    async ({ workspaceId, ...patch }) =>
      guard2(workspaceId, "The period could not be updated.", async () => {
        const before = await activePeriod();
        const after = await savePeriod(patch);
        const changed = (["label", "entity", "start", "end", "currency", "basis"] as const)
          .filter((k) => before[k] !== after[k])
          .map((k) => `${k}: ${before[k]} → ${after[k]}`);
        if (changed.length) {
          await record({
            actor: preparer(),
            action: "period.updated",
            subject: after.id,
            result: "ok",
            periodId: after.id,
            detail: `The filing period was edited through Claude. ${changed.join("; ")}.`,
          });
        }
        return { period: after, changed };
      }),
  );
}

