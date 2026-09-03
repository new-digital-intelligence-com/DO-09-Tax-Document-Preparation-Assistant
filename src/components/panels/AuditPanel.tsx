"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Empty,
  ErrorNote,
  Loading,
  Mono,
  SearchInput,
  Segmented,
  Table,
  Td,
  Toolbar,
  Tr,
  When,
} from "@/components/ui";
import type { AuditEvent } from "@/lib/types";

/**
 * The trail.
 *
 * Append-only, newest first. A refusal is as visible as an action here, and
 * deliberately so: "the revoke failed", "the note was blank so nothing was
 * closed" and "nobody has looked at this" are the entries that matter when
 * somebody is reconstructing what happened to a filing six months later. A
 * trail that records only successes is a trail that agrees with whoever reads
 * it.
 */

type Filter = "all" | "ok" | "error" | "info";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "ok", label: "Carried out" },
  { id: "error", label: "Failed" },
  { id: "info", label: "Noted" },
];

export function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/audit?limit=500")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `The trail responded ${response.status}.`);
        if (live) setEvents(Array.isArray(body) ? body : (body.events ?? []));
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "The trail could not be read.");
      });
    return () => {
      live = false;
    };
  }, []);

  const counts = useMemo(() => {
    const base = { all: events?.length ?? 0, ok: 0, error: 0, info: 0 };
    for (const event of events ?? []) base[event.result] += 1;
    return base;
  }, [events]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (events ?? []).filter((event) => {
      if (filter !== "all" && event.result !== filter) return false;
      if (!q) return true;
      return [event.action, event.actor, event.subject, event.detail]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [events, filter, query]);

  if (error) {
    return (
      <ErrorNote title="The audit trail could not be read">
        {error} Nothing is shown rather than an empty trail — an unreadable trail is not a quiet
        one.
      </ErrorNote>
    );
  }

  if (!events) return <Loading rows={8} label="Reading the trail…" />;

  return (
    <div className="space-y-4">
      <Toolbar>
        <Segmented
          options={FILTERS.map((f) => ({ ...f, count: counts[f.id] }))}
          value={filter}
          onChange={setFilter}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Action, actor, subject…"
          className="w-full sm:w-72"
        />
      </Toolbar>

      {rows.length === 0 ? (
        <Empty
          title={events.length === 0 ? "Nothing has happened yet" : "Nothing matches that"}
          hint={
            events.length === 0
              ? "The trail fills as documents are read, categorised and flagged."
              : "Clear the filter or the search to see the whole trail."
          }
        />
      ) : (
        <Table
          minWidth={860}
          head={[
            { label: "When", width: "170px" },
            { label: "Action", width: "180px" },
            { label: "Result", width: "110px" },
            { label: "Subject", width: "160px" },
            { label: "Detail" },
            { label: "Actor", width: "180px" },
          ]}
        >
          {rows.map((event) => (
            <Tr key={event.id}>
              <Td className="text-ink-2">
                <When at={event.at} relative />
              </Td>
              <Td>
                <Mono>{event.action}</Mono>
              </Td>
              <Td>
                <Badge
                  state={event.result === "ok" ? "resolved" : event.result === "error" ? "high" : "accepted"}
                  label={
                    event.result === "ok" ? "carried out" : event.result === "error" ? "failed" : "noted"
                  }
                  dot
                />
              </Td>
              <Td className="text-ink-2">{event.subject || "—"}</Td>
              <Td className="text-ink-2">{event.detail}</Td>
              <Td className="text-ink-3">{event.actor}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
