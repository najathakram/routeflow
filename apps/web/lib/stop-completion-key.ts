import { newStopCompletionKey } from "@routeflow/types/stop-completion-key";

/**
 * SA-1098 PR-2: the web driver screen's ONE Idempotency-Key per stop, kept in sessionStorage so a reloaded tab sends the SAME key
 * (a lost response then replays on the server instead of completing twice). The keep/release rule is the shared
 * `keepsStopCompletionKey`; only the store differs from mobile's in-memory Map. When storage is unavailable (private mode) the key
 * lives in memory for the page.
 */
const PREFIX = "rf-stop-key:";
const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function stopKey(stopId: string): string {
  const s = storage();
  try {
    const kept = s?.getItem(PREFIX + stopId) ?? memory.get(stopId);
    if (kept) return kept;
  } catch {
    /* fall through to a new key */
  }
  const key = newStopCompletionKey(stopId);
  memory.set(stopId, key);
  try {
    s?.setItem(PREFIX + stopId, key);
  } catch {
    /* memory copy still holds it */
  }
  return key;
}

export function releaseStopKey(stopId: string): void {
  memory.delete(stopId);
  try {
    storage()?.removeItem(PREFIX + stopId);
  } catch {
    /* nothing to release */
  }
}
