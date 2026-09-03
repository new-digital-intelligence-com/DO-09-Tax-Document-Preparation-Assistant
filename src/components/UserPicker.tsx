"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Button, ErrorNote, Field, InfoNote, Loading, Mono, When, inputClass } from "@/components/ui";

/**
 * The front door: whose filing is this.
 *
 * Nothing in the app is readable until somebody has been chosen, and that is
 * deliberate rather than a missing default. Every document, figure and draft
 * belongs to one named person's return, and a console that opened on whichever
 * workspace happened to be first would put one person's receipts under another
 * person's name.
 *
 * There is no sign-in here and this screen does not pretend otherwise. Picking
 * a name is a choice, not a proof of identity, and the audit trail records the
 * name that was selected.
 */

type User = {
  id: string;
  name: string;
  slug: string;
  driveFolderName: string;
  driveFolderId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

type Payload = {
  users: User[];
  active: User | null;
  drive: { state: "ready" | "needs-consent" | "unconfigured"; detail: string };
};

export function UserPicker({ onEntered }: { onEntered: (user: User) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/users");
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Users responded ${response.status}.`);
      setData(value as Payload);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The user list could not be read.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function enter(user: User) {
    setBusy(user.id);
    setError("");
    try {
      const response = await fetch("/api/users/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: user.id }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Switching responded ${response.status}.`);
      onEntered(value.active as User);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch to that user.");
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy("new");
    setError("");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? `Creating responded ${response.status}.`);
      setName("");
      setAdding(false);
      await enter(value.user as User);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The user could not be created.");
      setBusy(null);
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-48 h-[420px] bg-[radial-gradient(50%_60%_at_50%_50%,var(--brand),transparent_70%)] opacity-[0.07]"
      />

      <div className="relative mx-auto max-w-xl px-6 py-16 sm:py-24">
        <Image
          src="/logo.png"
          alt="NDI — New Digital Intelligence"
          width={301}
          height={168}
          priority
          className="logo h-8 w-auto"
        />

        <p className="mt-10 font-mono text-[11px] font-medium tracking-[0.22em] text-brand uppercase">
          DO-09
        </p>
        <h1 className="mt-3 text-[2rem] leading-[1.1] font-semibold">Whose filing is this?</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
          Every document, figure and draft belongs to one person&rsquo;s return, and each has their
          own folder on Drive. Choose a workspace to open it.
        </p>

        {error && (
          <div className="mt-6">
            <ErrorNote title="Something went wrong">{error}</ErrorNote>
          </div>
        )}

        {!data ? (
          <div className="mt-8">
            <Loading rows={3} label="Reading the workspaces…" />
          </div>
        ) : (
          <>
            <ul className="mt-8 space-y-2">
              {data.users.map((user) => (
                <li key={user.id}>
                  <button
                    onClick={() => enter(user)}
                    disabled={Boolean(busy)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-card transition hover:border-border-strong disabled:opacity-50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-[14px] font-semibold text-brand uppercase">
                      {user.name.slice(0, 2)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium">{user.name}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink-3">
                        <Mono>{user.driveFolderName}</Mono>
                        {user.lastUsedAt && (
                          <>
                            {" · last opened "}
                            <When at={user.lastUsedAt} relative />
                          </>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-brand">
                      {busy === user.id ? "…" : <Icon name="chevron" className="size-4" />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {data.users.length === 0 && !adding && (
              <div className="mt-8 rounded-xl border border-dashed border-border px-6 py-10 text-center">
                <p className="text-[14px] font-medium">No workspaces yet</p>
                <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-2">
                  Add the first one. A folder is created for it on Drive, with its own input and
                  output.
                </p>
              </div>
            )}

            {adding ? (
              <form onSubmit={add} className="mt-6 space-y-3 rounded-xl border border-border bg-surface p-4">
                <Field
                  label="Name"
                  hint="Used for the workspace and its Drive folder. A name already here opens that workspace rather than making a second one."
                  required
                >
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Helmi"
                    maxLength={60}
                    className={inputClass}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setAdding(false);
                      setName("");
                    }}
                    disabled={Boolean(busy)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" busy={busy === "new"} disabled={!name.trim()}>
                    Create and open
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                variant="secondary"
                className="mt-6 w-full"
                onClick={() => setAdding(true)}
                disabled={Boolean(busy)}
              >
                Add a workspace
              </Button>
            )}

            {data.drive.state !== "ready" && (
              <div className="mt-8">
                <InfoNote title="Drive is not connected yet">
                  {data.drive.detail}{" "}
                  {data.drive.state === "needs-consent" && (
                    <a className="underline" href="/api/drive/connect">
                      Grant access
                    </a>
                  )}
                </InfoNote>
              </div>
            )}
          </>
        )}

        <p className="mt-12 font-mono text-[11px] tracking-[0.16em] text-ink-3 uppercase">
          New Digital Intelligence
        </p>
      </div>
    </div>
  );
}
