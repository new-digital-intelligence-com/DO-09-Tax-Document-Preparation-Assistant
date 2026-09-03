"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/shell";
import { ErrorNote } from "@/components/ui";
import { OverviewPanel } from "@/components/panels/OverviewPanel";
import { WorkspacePanel } from "@/components/panels/WorkspacePanel";
import { DocumentsPanel } from "@/components/panels/DocumentsPanel";
import { CategoriesPanel } from "@/components/panels/CategoriesPanel";
import { ExceptionsPanel } from "@/components/panels/ExceptionsPanel";
import { FormsPanel } from "@/components/panels/FormsPanel";
import { PackagePanel } from "@/components/panels/PackagePanel";
import { AskPanel } from "@/components/panels/AskPanel";
import { AuditPanel } from "@/components/panels/AuditPanel";
import type { PrepStatus } from "@/lib/types";

/**
 * The console.
 *
 * One page holding nine panels, with the section in the query string so a
 * screen can be linked to — "the reconciliation is wrong on this period" is a
 * sentence somebody sends with a URL, and a console that always opens on the
 * overview makes them describe the route instead.
 *
 * The shell owns navigation and the flag count. Each panel fetches its own
 * data: they are read at different moments, cost different amounts, and a
 * single page-level fetch would make the cheapest screen wait for the dearest.
 */

const PANELS: Record<string, () => React.ReactElement> = {
  overview: OverviewPanel,
  workspace: WorkspacePanel,
  documents: DocumentsPanel,
  categories: CategoriesPanel,
  exceptions: ExceptionsPanel,
  forms: FormsPanel,
  package: PackagePanel,
  ask: AskPanel,
  audit: AuditPanel,
};

const TITLES: Record<string, { title: string; description: string }> = {
  overview: {
    title: "Overview",
    description: "Where the period stands, and what is waiting on a person.",
  },
  workspace: {
    title: "Workspace",
    description:
      "The shared Drive folder. Results are written back to it, so a second run does not pay to read the same document twice.",
  },
  documents: {
    title: "Documents",
    description: "Everything collected for the period, and what was read off each one.",
  },
  categories: {
    title: "Categories",
    description: "Totals by tax category, recorded against what reaches a form line.",
  },
  exceptions: {
    title: "Exceptions",
    description: "Everything flagged for a person, with the reason and what would close it.",
  },
  forms: {
    title: "Draft forms",
    description: "Pre-filled from the categorised documents. Drafts only — nothing is filed.",
  },
  package: {
    title: "Review package",
    description: "The handoff: index, drafts, reconciliation and the open items.",
  },
  ask: { title: "Ask", description: "Question the register. It reads and prepares; it does not file." },
  audit: { title: "Audit", description: "Append-only. Refusals are in here as readily as actions." },
};

export default function PrepPage() {
  const [section, setSection] = useState("overview");
  const [status, setStatus] = useState<PrepStatus | null>(null);
  const [user, setUser] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [error, setError] = useState("");

  // Read the section from the URL on mount and on back/forward, so a linked
  // screen opens on the screen that was linked.
  useEffect(() => {
    const read = () => {
      const wanted = new URLSearchParams(window.location.search).get("section") ?? "overview";
      setSection(PANELS[wanted] ? wanted : "overview");
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  // No workspace chosen means nothing on this page has an owner, so it sends
  // the operator back to choose rather than rendering somebody's figures under
  // no name at all.
  useEffect(() => {
    let live = true;
    fetch("/api/users/active")
      .then((r) => r.json())
      .then((body) => {
        if (!live) return;
        if (!body?.active) window.location.href = "/";
        else setUser(body.active);
      })
      .catch(() => live && setUser(null));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let live = true;
    fetch("/api/status")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Status responded ${response.status}`);
        if (live) setStatus(body as PrepStatus);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "The period could not be read.");
      });
    return () => {
      live = false;
    };
  }, [section, user]);

  const navigate = useCallback((id: string) => {
    setSection(id);
    const url = new URL(window.location.href);
    url.searchParams.set("section", id);
    window.history.pushState(null, "", url);
  }, []);

  const Panel = PANELS[section] ?? OverviewPanel;
  const heading = TITLES[section] ?? TITLES.overview;

  // Counts the sidebar shows. Left undefined rather than zeroed when the
  // status call failed: a sidebar reading "0 exceptions" over a request that
  // never landed is the console telling the reviewer their books are clean.
  const counts = status
    ? {
        documents: status.counts.documents,
        openExceptions: status.exceptions.open,
      }
    : {};

  return (
    <AppShell
      active={section}
      counts={counts}
      period={status?.period.label}
      entity={status?.period.entity}
      user={user ?? undefined}
      onNavigate={navigate}
    >
      <PageHeader title={heading.title} description={heading.description} />
      {error && (
        <div className="mb-4">
          <ErrorNote title="The period could not be read">
            {error} Counts in the sidebar are hidden rather than shown as zero.
          </ErrorNote>
        </div>
      )}
      <Panel />
    </AppShell>
  );
}
