import { QueryClient } from "@tanstack/react-query";
import type { Me } from "./api";

/** Each mounted authenticated session owns its query and mutation caches. */
export function createSessionQueryClient(authClient: QueryClient): QueryClient {
  return new QueryClient({ defaultOptions: authClient.getDefaultOptions() });
}

const AUTH_SIGNAL = "jiange:auth-session-changed";

/** Notify other same-origin tabs without disclosing any account or draft data. */
export function announceAuthChange(): void {
  if (typeof window === "undefined") return;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_SIGNAL);
      channel.postMessage("changed");
      channel.close();
      return;
    }
  } catch { /* Fall back to the browser storage event. */ }
  try { window.localStorage.setItem(AUTH_SIGNAL, `${Date.now()}-${Math.random()}`); }
  catch { /* No inter-tab channel is available; do not block login. */ }
}

/** Subscribe only to an opaque signal; identity is revalidated with /api/me. */
export function subscribeAuthChanges(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_SIGNAL);
      channel.onmessage = (event) => { if (event.data === "changed") onChange(); };
      return () => channel.close();
    }
  } catch { /* Fall back to the browser storage event. */ }
  const listener = (event: StorageEvent) => { if (event.key === AUTH_SIGNAL) onChange(); };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** Publish the newly authenticated identity only after prior auth reads stop. */
export async function finishLogin(authClient: QueryClient, me: Me): Promise<void> {
  await authClient.cancelQueries();
  // Public/authentication screens may also have populated the outer client.
  // Never reuse account-scoped data from a previous authentication session.
  authClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
  authClient.setQueryData(["me"], me);
  announceAuthChange();
}
