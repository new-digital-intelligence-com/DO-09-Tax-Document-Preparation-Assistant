import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which workspace the current call is acting on, when there is no cookie.
 *
 * The console picks a workspace with an HTTP cookie, which works because a
 * browser carries it on every request. The MCP server has no such thing: each
 * JSON-RPC call is its own stateless request, so a `use_workspace` tool that
 * set a cookie would be forgotten by the very next call — and the tool after it
 * would read an empty workspace and report zero documents, which is the worst
 * possible failure here because it looks exactly like a clean quarter.
 *
 * So the workspace travels with the call instead. `AsyncLocalStorage` rather
 * than a module-level variable, because a module-level one is shared by every
 * request an instance is handling at that moment: two people working two
 * workspaces would overwrite each other's selection and read each other's
 * figures, intermittently and unreproducibly.
 *
 * Nothing else changes. `activeUser()` checks here first and falls back to the
 * cookie, so every function underneath it is unaware there are two ways in.
 */
const store = new AsyncLocalStorage<{ workspaceId: string }>();

export function withWorkspace<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  return store.run({ workspaceId }, run);
}

/** The workspace for this call, or nothing if the caller is cookie-based. */
export function scopedWorkspaceId(): string | undefined {
  return store.getStore()?.workspaceId;
}
