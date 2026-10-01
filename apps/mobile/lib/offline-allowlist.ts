/**
 * B923: ONLY an explicit allow-list of offline-safe endpoints may enter the offline queue (store/
 * offlineQueue.ts, drained by hooks/useNetworkSync -> lib/queue-drain.ts). Every other mutation is
 * online-only: api-client's response interceptor does not enqueue it and rejects with
 * {@link ONLINE_REQUIRED_MESSAGE} (`isOnlineRequired: true`, never `isOfflineQueued`, which screens read
 * as a pending SUCCESS).
 *
 * An entry may be added ONLY with a reason and a replay-safety story: the queue replays a request after
 * the response was lost, so the server must either dedupe it (an `Idempotency-Key` header the client
 * already sends) or accept a second identical write by contract. The static guard
 * (__tests__/offline-allowlist-static.test.ts) fails the build for any mutating call site that is neither
 * on this list nor in __tests__/offline-online-only-inventory.json.
 *
 * Replay is NOT restricted: entries persisted under the old default (users were told "queued") still
 * drain (see {@link countLegacyNonAllowlisted} for the one-time count).
 */
export const ONLINE_REQUIRED_MESSAGE = "You're offline. Connect and try again.";

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

export interface OfflineSafeEntry {
  method: Method;
  /** Anchored, tested against the path with any query string removed. */
  pattern: RegExp;
  reason: string;
  replaySafety: "idempotency-key" | "idempotent-by-contract";
  replayNote: string;
}

export const OFFLINE_SAFE_ENDPOINTS: readonly OfflineSafeEntry[] = [
  {
    method: "POST",
    pattern: /^\/orders$/,
    reason:
      "A customer or driver places an order in the field with no signal; it must not be lost.",
    replaySafety: "idempotency-key",
    replayNote:
      "Idempotency-Key header per cart session (F30/R8); the server returns the original order.",
  },
  {
    method: "POST",
    pattern: /^\/returns$/,
    reason:
      "A return captured at the door while offline must reach the office once signal returns.",
    replaySafety: "idempotency-key",
    replayNote:
      "Deterministic Idempotency-Key header (return-submit-key); a replay returns the original return.",
  },
  {
    method: "POST",
    pattern: /^\/returns\/inline\/capture$/,
    reason: "An inline return captured with the order must survive a lost connection.",
    replaySafety: "idempotent-by-contract",
    replayNote:
      "Deduped on the returnKey in the request body (inline-return-submit-key), not a header; a replay collapses onto the original capture.",
  },
  {
    method: "PATCH",
    pattern: /^\/route-runs\/[^/]+\/stops\/[^/]+$/,
    reason: "The driver starts or skips a stop while offline; the route state must catch up later.",
    replaySafety: "idempotent-by-contract",
    replayNote:
      "Sets a stop status (IN_PROGRESS or SKIPPED); applying the same status twice is a no-op.",
  },
  {
    method: "POST",
    pattern: /^\/route-runs\/[^/]+\/stops\/[^/]+\/complete-with-payment$/,
    reason: "The driver closes a delivery stop (and records its payment) with no signal.",
    replaySafety: "idempotency-key",
    replayNote:
      "Idempotency-Key header; the server also refuses any write once the stop is COMPLETED.",
  },
  {
    method: "POST",
    pattern: /^\/route-runs\/[^/]+\/stops\/[^/]+\/pod-artifact$/,
    reason: "A proof-of-delivery photo captured offline is attached when the signal returns.",
    replaySafety: "idempotent-by-contract",
    replayNote: "Keyed by a client artifact id (pod-artifacts); a replay overwrites the same key.",
  },
  {
    method: "POST",
    pattern: /^\/orders\/[^/]+\/change-requests\/[^/]+\/resolve$/,
    reason: "The driver resolves or declines an at-door change at the stop while offline.",
    replaySafety: "idempotent-by-contract",
    replayNote:
      "First resolution wins; a repeat answers 409 CHANGE_REQUEST_ALREADY_RESOLVED, handled by the queue drain.",
  },
];

function pathOf(url: string): string {
  return url.split("#")[0].split("?")[0];
}

/** True when a no-response `method url` may be queued for offline replay. */
export function isOfflineSafe(method: string, url: string): boolean {
  const m = method.toUpperCase();
  const path = pathOf(url);
  return OFFLINE_SAFE_ENDPOINTS.some((e) => e.method === m && e.pattern.test(path));
}

function hasIdempotencyKey(headers: unknown): boolean {
  if (!headers || typeof headers !== "object") return false;
  return Object.entries(headers as Record<string, unknown>).some(
    ([k, v]) => k.toLowerCase() === "idempotency-key" && typeof v === "string" && v.length > 0,
  );
}

/**
 * B923 (B1): the queue replays a request after its response was lost, so an entry whose safety IS an
 * Idempotency-Key (`replaySafety: "idempotency-key"`) may be queued only when THIS request carries one.
 * Enforced at runtime in the interceptor for every screen, not per call site.
 */
export function isOfflineQueueable(method: string, url: string, headers?: unknown): boolean {
  const m = method.toUpperCase();
  const path = pathOf(url);
  const entry = OFFLINE_SAFE_ENDPOINTS.find((e) => e.method === m && e.pattern.test(path));
  if (!entry) return false;
  return entry.replaySafety !== "idempotency-key" || hasIdempotencyKey(headers);
}

/** A path segment that contains a digit or an upper-case letter is an id, not a route word. */
function normalizeForCount(endpoint: string): string {
  return pathOf(endpoint)
    .split("/")
    .map((seg) => (seg && (/\d/.test(seg) || /[A-Z]/.test(seg)) ? ":id" : seg))
    .join("/");
}

export interface LegacyReplayCount {
  total: number;
  /** "METHOD /normalized/path" -> how many persisted entries. Never carries an id or a body. */
  byEndpoint: Record<string, number>;
}

/**
 * B923 ruling 5: how many entries persisted under the OLD default are about to replay although the
 * allow-list no longer admits them. Logged once per app session so we can see when it hits zero.
 */
export function countLegacyNonAllowlisted(
  actions: readonly { method: string; endpoint: string }[],
): LegacyReplayCount {
  const byEndpoint: Record<string, number> = {};
  let total = 0;
  for (const a of actions) {
    if (isOfflineSafe(a.method, a.endpoint)) continue;
    total += 1;
    const key = `${a.method.toUpperCase()} ${normalizeForCount(a.endpoint)}`;
    byEndpoint[key] = (byEndpoint[key] ?? 0) + 1;
  }
  return { total, byEndpoint };
}
