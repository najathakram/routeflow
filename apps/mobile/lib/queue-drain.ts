/**
 * F30 / REG-B196 / REG-B143 / REG-B111.
 *
 * `useNetworkSync.ts`'s drain loop used to live entirely inside the hook's
 * closure, which made it untestable as pure logic (mobile tests are
 * pure-logic only — no component/hook rendering). This module is the
 * extraction the hook delegates to, so the drain mechanics below can be
 * pinned by jest without a React tree:
 *
 *  - `buildReplayRequestConfig` marks a replayed action's request (the old
 *    code sent a bare `{method, url, data, headers}` with NO marker) so
 *    api-client's response interceptor recognizes a timed-out replay as a
 *    replay instead of enqueuing a brand-new, duplicate queue entry
 *    (REG-B196).
 *  - `drainQueue` never lets a 4xx or a retry-exhausted entry vanish
 *    silently — both land in `failedActions` with a reason instead of being
 *    dequeued with zero signal (REG-B143 / REG-B111).
 */
import type { QueuedAction } from "../store/offlineQueue";

export const MAX_RETRIES = 3;

export interface ReplayRequestConfig {
  url: string;
  method: string;
  data?: unknown;
  headers?: Record<string, string>;
  /**
   * Marks this request as a queue replay. api-client's response interceptor
   * already skips its enqueue branch when `_offlineQueued` is present on the
   * failing request's config (see the `!original?._offlineQueued` guard) —
   * the bug is that today's drain loop never sets it on the request it
   * builds for a replay.
   */
  _offlineQueued: true;
}

/**
 * Build the request config a queue replay issues for `action`. Carries the
 * `_offlineQueued` marker (see ReplayRequestConfig) so a timed-out replay
 * increments the SAME entry's retry count instead of enqueuing a duplicate.
 */
export function buildReplayRequestConfig(action: QueuedAction): ReplayRequestConfig {
  return {
    url: action.endpoint,
    method: action.method,
    data: action.body,
    ...(action.headers ? { headers: action.headers } : {}),
    _offlineQueued: true,
  };
}

export interface FailedActionRecord {
  action: QueuedAction;
  /** Human-readable reason surfaced to the operator (alertInfo/InlineToast). */
  reason: string;
  failedAt: number;
}

export interface DrainResult {
  /** Ids that succeeded — safe to dequeue. */
  delivered: string[];
  /** Ids that hit a retriable failure — left queued, retries incremented. */
  retriedIds: string[];
  /**
   * Entries that must NEVER be silently dropped: a non-retriable 4xx or an
   * already retry-exhausted entry. These are persisted to the offline queue
   * store's `failedActions` list and alerted — never just dequeued.
   */
  failedActions: FailedActionRecord[];
}

export interface DrainDeps {
  /** Issue the actual HTTP call for one queued action (e.g. via apiClient). */
  request: (action: QueuedAction) => Promise<unknown>;
  /**
   * Called once per entry that lands in `failedActions`, as it is classified —
   * this is the persistence hook (the store's `addFailedAction`). REQUIRED on
   * purpose: the caller dequeues everything in `failedActions`, so a drain
   * that cannot record them is REG-B143 verbatim — the order leaves the queue
   * with no badge and no trace. While this was optional, omitting it compiled
   * cleanly and no-op'd silently, which is the one outcome this module exists
   * to prevent. The operator alert is raised ONCE for the whole drain by the
   * caller, from `describeFailedDrain` — see that function for why.
   */
  notifyFailed: (record: FailedActionRecord) => void;
}

/**
 * The server's own explanation, when it sent one. Axios's `err.message` is
 * always the generic "Request failed with status code 409", which tells the
 * operator nothing; Nest sends the useful text in `response.data.message`
 * (a string, or an array of them from class-validator).
 */
function serverMessage(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (typeof data === "string") return data.trim() || undefined;
  const message = (data as { message?: unknown } | undefined)?.message;
  if (typeof message === "string") return message.trim() || undefined;
  if (Array.isArray(message)) {
    return message.filter((m): m is string => typeof m === "string").join("; ") || undefined;
  }
  return undefined;
}

/**
 * True when `err` is an order-merge advisory-lock contention response — the
 * API raises these ONLY before any write (see
 * apps/api/src/common/db-locks.ts / src/orders/merge-contention.ts), so a
 * retry is always safe: a 409 `{ code: "MERGE_IN_PROGRESS" }` (another merge
 * for this customer is running) or a 503 `{ code: "LOCK_UNAVAILABLE" }`
 * (couldn't acquire the lock connection). Both take the SAME path as a
 * 5xx/network failure instead of the non-retriable 4xx path a bare
 * `status >= 400 && status < 500` check would put the 409 on — the item
 * stays queued and is retried on the next drain.
 */
function isRetriableLockContention(err: unknown, status: number | undefined): boolean {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    { code?: unknown } | undefined;
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (status === 409 && code === "MERGE_IN_PROGRESS") return true;
  if (status === 503 && code === "LOCK_UNAVAILABLE") return true;
  return false;
}

/**
 * Pure drain step over the current queue. Classifies every action into
 * exactly one of delivered / retriedIds / failedActions — nothing is ever
 * silently discarded (REG-B143 / REG-B111).
 *
 * An entry that has already exhausted MAX_RETRIES is never re-attempted —
 * it goes straight to failedActions. Everything else is attempted via
 * `deps.request`: success delivers, a non-retriable 4xx response fails
 * (never a bare dequeue), and anything else (5xx, network/timeout errors,
 * or a merge-lock-contention 409/503 — see `isRetriableLockContention`) is
 * left queued with its retry count bumped by the caller.
 */
export async function drainQueue(actions: QueuedAction[], deps: DrainDeps): Promise<DrainResult> {
  const delivered: string[] = [];
  const retriedIds: string[] = [];
  const failedActions: FailedActionRecord[] = [];

  for (const action of actions) {
    if (action.retries >= MAX_RETRIES) {
      const record: FailedActionRecord = {
        action,
        reason: `Retries exhausted after ${MAX_RETRIES} attempts`,
        failedAt: Date.now(),
      };
      failedActions.push(record);
      deps.notifyFailed(record);
      continue;
    }

    try {
      await deps.request(action);
      delivered.push(action.id);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const isNonRetriableClientError =
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        !isRetriableLockContention(err, status);
      if (isNonRetriableClientError) {
        const message = serverMessage(err) ?? (err instanceof Error ? err.message : String(err));
        const record: FailedActionRecord = {
          action,
          reason: `HTTP ${status}: ${message}`,
          failedAt: Date.now(),
        };
        failedActions.push(record);
        deps.notifyFailed(record);
      } else {
        retriedIds.push(action.id);
      }
    }
  }

  return { delivered, retriedIds, failedActions };
}

/**
 * What the operator lost, in their own vocabulary — "New order (3 items)"
 * rather than "POST /orders". A failure caption that names an HTTP method and
 * a URL is unactionable at 2am, which is half of what R6 is about; the id in
 * the path is a uuid, so the label leans on the body instead. Unmapped
 * endpoints fall back to method + path rather than inventing a noun.
 */
export function describeQueuedAction(action: QueuedAction): string {
  const path = action.endpoint.split("?")[0].replace(/\/+$/, "");
  const body = (action.body ?? {}) as { items?: unknown };

  if (action.method === "POST" && path === "/orders") {
    const items = Array.isArray(body.items) ? body.items.length : 0;
    return items > 0 ? `New order (${items} item${items === 1 ? "" : "s"})` : "New order";
  }
  if (/^\/orders\/[^/]+\/items$/.test(path)) return "Order item changes";
  if (/^\/orders\/[^/]+\/status$/.test(path)) return "Order status change";
  if (/^\/route-runs\/[^/]+\/stops\/[^/]+\/complete$/.test(path)) return "Delivery completion";
  return `${action.method} ${action.endpoint}`;
}

/** Failures listed in full in the drain alert before it summarizes the rest. */
const MAX_ALERTED_FAILURES = 3;

/**
 * ONE alert for the whole drain. Alerting per record meant a reconnect with
 * three stale entries stacked three modals back to back — each captioned with
 * a bare endpoint — so the operator dismissed a pile of dialogs and still
 * didn't know what was gone. The standing badge (OfflineBanner) is where the
 * full list lives; this is the one-shot heads-up.
 */
export function describeFailedDrain(records: FailedActionRecord[]): {
  title: string;
  message: string;
} {
  // Matches OfflineBanner's stance: nothing is resent automatically (a 4xx
  // replay fails identically), so the honest instruction is to re-enter it.
  const footer =
    "Failures stay listed in the banner at the top of the screen. Nothing is resent automatically — re-enter the affected work.";

  if (records.length === 1) {
    const [only] = records;
    return {
      title: "Couldn't complete an action",
      message: `${describeQueuedAction(only.action)} could not be sent — ${only.reason}\n\n${footer}`,
    };
  }

  const shown = records
    .slice(0, MAX_ALERTED_FAILURES)
    .map((r) => `• ${describeQueuedAction(r.action)} — ${r.reason}`)
    .join("\n");
  const rest = records.length - MAX_ALERTED_FAILURES;
  return {
    title: `${records.length} actions could not be sent`,
    message: `${shown}${rest > 0 ? `\n• …and ${rest} more` : ""}\n\n${footer}`,
  };
}
