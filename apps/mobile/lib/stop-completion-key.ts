/**
 * Row 108 (SA-706h, #3213 client condition): one idempotency key per stop across retries, kept IN MEMORY here (a restarted app
 * starts a fresh attempt, which the server's "stop already completed" check covers). The rule itself (when to keep or release
 * the key, the lock retry) moved to `@routeflow/types` in SA-1098 PR-2a so the web driver screen shares it.
 */
import { newStopCompletionKey } from "@routeflow/types/stop-completion-key";

export {
  LOCK_RETRY_DELAYS_MS,
  isLockUnavailable,
  keepsStopCompletionKey,
  retryOnLockUnavailable,
} from "@routeflow/types/stop-completion-key";

const keys = new Map<string, string>();

export function stopCompletionKey(stopId: string): string {
  let key = keys.get(stopId);
  if (!key) {
    key = newStopCompletionKey(stopId);
    keys.set(stopId, key);
  }
  return key;
}

export function releaseStopCompletionKey(stopId: string): void {
  keys.delete(stopId);
}
