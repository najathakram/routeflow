/**
 * Deterministic, offline-queue-safe `returnKey` for `POST /returns/inline/capture` (Returns
 * Inside Order Creation — PR 3, mobile mirror). Mirrors `lib/return-submit-key.ts`'s recipe,
 * NOT its implementation — the two endpoints have different bodies (`returnKey` field here vs.
 * an `Idempotency-Key` header there) but the same underlying hazard.
 *
 * WHY A PLAIN `useRef` (web's PR 1 approach) IS WRONG HERE: web has no offline queue — a killed
 * tab is a lost attempt, nothing replays. Mobile's failure mode is different IN KIND: app
 * killed mid-request, relaunch, the offline queue replays the same POST. A `useRef` UUID would
 * mint a NEW value on relaunch, the server would see a different `returnKey`, and
 * `InlineReturnsService.capture()` would mint a SECOND credit note for the same goods — a
 * duplicate-money defect on the exact endpoint whose entire idempotency story is `returnKey`.
 * Mirroring the CONTRACT (mobile mirrors web) means mirroring this pattern, not the ref.
 *
 * IDENTITY = customerId + orderId (the CARRYING order) + a per-attempt NONCE. Deliberately NOT
 * the quantities or the reason: like web's RecordInlineReturnDialog, ONE key covers one capture
 * ATTEMPT, stable across edits, re-quotes and retries. A capture that timed out after the server
 * committed and is then edited (12 -> 10) or re-quoted must resend the SAME key so the server
 * collapses it onto the committed Return; a quantity-derived key minted a second Return, credit
 * and restock (Opus review of #1270). A genuinely NEW capture on the pair gets a fresh nonce
 * because the previous attempt settled (success or a definite refusal).
 *
 * THE NONCE IS THE WHOLE POINT, AND IT IS SUBTLE: it must be PERSISTED and RE-READ, never
 * reminted on relaunch — a reminted nonce on every replay defeats the pattern entirely (see
 * `inlineReturnSubmissionStore.ts`, which does the actual persisting; this file holds ONLY the
 * pure key derivation + nonce-map reducer logic, tested here without any AsyncStorage/zustand
 * dependency, per this project's mobile-tests-are-pure-logic-only convention — see
 * `returns-logic.ts#submittedReturnKey` for the same split on the standard-return flow).
 */

import { API_ERROR_CODES } from "@routeflow/types";

/** Header/body-safe: every real component is a UUID or a small integer, so this never fires in
 *  practice — here so a surprising id can never produce something the wire can't carry. */
function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9:,._-]/g, "_");
}

export interface InlineReturnSubmitKeyInput {
  customerId: string;
  orderId: string;
}

/** The stable lookup key for the nonce map — identifies the (customer, carrying order) pair
 *  an in-flight attempt belongs to, independent of the quantities being requested (those can
 *  change across a re-quote without starting a new attempt). */
export function inlineReturnNonceKey(customerId: string, orderId: string): string {
  return `${customerId}:${orderId}`;
}

/** The `returnKey` sent on the wire for one attempt — quantity-independent by design. */
export function inlineReturnSubmitKey(input: InlineReturnSubmitKeyInput, nonce: string): string {
  return safeToken(`inl:${input.customerId}:${input.orderId}:${nonce}`);
}

// ─── Pure nonce-map reducer (the part a store just wires up) ────────────────────
//
// `inlineReturnSubmissionStore.ts` is a thin zustand+persist wrapper over these three
// functions — kept here, pure and dependency-free, so the property that actually matters
// (persist-and-reuse until a terminal state, mint fresh after one) is tested without needing
// AsyncStorage or a real store instance.

export type NonceMap = Readonly<Record<string, string>>;

/** Returns the existing nonce for `key` unchanged, or mints a fresh one — never remints an
 *  existing entry. This is what "persisted and re-read across a relaunch" reduces to: the
 *  caller is responsible for handing this function the map it read back from storage, and for
 *  writing the returned map back. */
export function getOrCreateNonce(
  nonces: NonceMap,
  key: string,
  mint: () => string,
): { nonce: string; nonces: NonceMap } {
  const existing = nonces[key];
  if (existing) return { nonce: existing, nonces };
  const minted = mint();
  return { nonce: minted, nonces: { ...nonces, [key]: minted } };
}

/** Clears `key`'s nonce — call once the attempt it belonged to reaches a terminal state
 *  (landed or definitively failed), so the NEXT attempt for the same (customer, order) pair
 *  mints a genuinely fresh nonce instead of silently reusing this one. */
export function clearNonce(nonces: NonceMap, key: string): NonceMap {
  if (!(key in nonces)) return nonces;
  const { [key]: _cleared, ...rest } = nonces;
  return rest;
}

/** Clears `key` only when its stored nonce is `nonce` — a settle belongs to ONE attempt, so a
 *  late outcome from an older attempt must never clear a newer attempt's nonce. */
export function clearNonceIf(nonces: NonceMap, key: string, nonce: string): NonceMap {
  return nonces[key] === nonce ? clearNonce(nonces, key) : nonces;
}

/**
 * B742's sibling money bug for this flow (SA-091, precision corrections SA-091a/SA-091b): settle
 * the nonce on a DEFINITE outcome, keep it on anything UNCERTAIN. A capture's outcome is one of
 * three shapes, not two — "the server answered" is not the same thing as "the outcome is known":
 *  - success: the return landed. Settle — the NEXT attempt for this pair must mint fresh.
 *  - a DEFINITE refusal (400-499, excluding the retry-signal below): the request was malformed
 *    or rejected before anything was written — terminal, exactly like a success. The same nonce
 *    must not be reused by a later, GENUINELY NEW capture on the same customer/order pair, or
 *    that new capture's returnKey collides with the refused attempt's and the server silently
 *    replays the OLD record instead of processing the new one.
 *  - anything UNCERTAIN — no response at all (connectivity failure, app killed first), a 5xx, OR
 *    the retry-signal 409 below: a 5xx means the request reached the server, but whether the
 *    capture COMMITTED before the response failed is unknown. Settling here would let a retry
 *    mint a fresh key — and if the first attempt actually did commit, that fresh key mints a
 *    SECOND, duplicate credit note for the same goods (worse: `InlineReturnsService.capture()`
 *    commits the Return row and issues its credit in SEPARATE transactions — a 5xx can mean the
 *    Return exists with no credit yet, and the SAME returnKey is what lets a retry finish it
 *    idempotently, per the service's own "RECEIVED with no credit or hold" self-heal). Keep the
 *    nonce so a retry (manual or the offline queue's replay) reuses the SAME returnKey and
 *    collapses onto whatever the first attempt actually did, never doubling it.
 */
export type InlineReturnCaptureOutcome = { kind: "success" } | { kind: "error"; refused: boolean };

export function shouldSettleInlineReturnNonce(outcome: InlineReturnCaptureOutcome): boolean {
  return outcome.kind === "success" || outcome.refused;
}

/**
 * The exact literal `InlineReturnsService`'s stuck-row race throws (inline-returns.service.ts,
 * `issueCreditInTx`'s `linked.count === 0` guard). A cross-repo string contract until that
 * ConflictException gets a real code (proposed follow-up: `RETURN_STATE_RACE_RETRY`) — pinned
 * here AND in the API's own spec so neither side can reword it without the other noticing.
 */
export const RETURN_STATE_RACE_RETRY_MESSAGE = "Return changed state during credit issue — retry";

/**
 * The capture service's own refusal codes (apps/api `INLINE_RETURN_ERROR_CODES`, pinned set-equal
 * by inline-returns.service.spec.ts, which reads this file). A 4xx is a DEFINITE refusal ONLY
 * when its body carries one of these — a post-lookup business refusal is terminal.
 */
export const INLINE_RETURN_REFUSAL_CODES: readonly string[] = [
  "INLINE_RETURN_ORDER_NOT_FOUND",
  "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
  "INLINE_RETURN_ORDER_CANCELLED",
  "INLINE_RETURN_KEY_CONFLICT",
  // #2424: the same key with different items is refused, so the nonce settles and the next
  // capture mints a new key (and re-quotes).
  "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
  // B961: nothing was written; the nonce settles and the next capture (with the reason) mints a new key.
  "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
];

/**
 * SA-740: the source-sale refusals of the capture (a counter return names no usable source sale, or asks for more than the sale
 * had). Nothing was written, so each is as definite as the codes above. Spelled through the shared constants (the codes list
 * is shrink-only for bare literals); pinned to the server's three by inline-returns-source-sale.spec.ts.
 */
export const SOURCE_SALE_REFUSAL_CODES: readonly string[] = [
  API_ERROR_CODES.SOURCE_SALE_REQUIRED,
  API_ERROR_CODES.SOURCE_SALE_INVALID,
  API_ERROR_CODES.RETURN_EXCEEDS_SALE,
];

/**
 * The one place that decides "refused" for this endpoint (SA-204) — shared by the direct error
 * path (`captureOutcomeFromError`), the offline-queue drain path and the sign-in rebuild, so they
 * can never classify the same error differently. SUCCESS settles; a 4xx settles ONLY when its
 * body carries the capture service's own error `code`, EXCEPT the retry-409. Everything else
 * KEEPS the nonce: 401 / 403 (answered before the key lookup — permission may be restored and the
 * retry must resend the SAME key), 408, 429, a code-less 400 (the validation pipe), any 5xx, and
 * no response at all.
 */
export function isDefiniteInlineReturnRefusal(
  status: number | undefined,
  code: string | undefined,
  message?: string,
): boolean {
  if (status === undefined || status < 400 || status >= 500) return false;
  if (status === 401 || status === 403 || status === 408 || status === 429) return false;
  if (status === 409 && message?.endsWith("retry")) return false;
  return (
    code !== undefined &&
    (INLINE_RETURN_REFUSAL_CODES.includes(code) || SOURCE_SALE_REFUSAL_CODES.includes(code))
  );
}

/**
 * Classifies an axios-shaped capture error for `useCaptureInlineReturn`'s `onError` — pure, no
 * axios import, tested with plain fixtures. `{ kind: "queued" }` is a THIRD shape distinct from
 * `InlineReturnCaptureOutcome`: apiClient's offline-queue interceptor throws an
 * `isOfflineQueued` error when it queues a request rather than letting it fail — that request
 * has not been attempted yet at all, so nothing about its outcome is known until the queue
 * actually drains it (`settleAfterDrain`, below, handles that later, real outcome).
 */
export function captureOutcomeFromError(
  err: unknown,
): InlineReturnCaptureOutcome | { kind: "queued" } {
  if (err && typeof err === "object" && "isOfflineQueued" in err && (err as any).isOfflineQueued) {
    return { kind: "queued" };
  }
  const response = (
    err as {
      response?: { status?: number; data?: { message?: unknown; code?: unknown } };
    }
  )?.response;
  const status = response?.status;
  const message = typeof response?.data?.message === "string" ? response.data.message : undefined;
  const code = typeof response?.data?.code === "string" ? response.data.code : undefined;
  return { kind: "error", refused: isDefiniteInlineReturnRefusal(status, code, message) };
}

/** The nonce is always the FINAL `:`-delimited token in a returnKey (see
 *  `inlineReturnSubmitKey` above) — the customer and order ids may themselves contain colons,
 *  but nothing is ever appended after the nonce, so the last segment is unambiguous. */
export function nonceSuffixFromReturnKey(returnKey: string): string {
  const parts = returnKey.split(":");
  return parts[parts.length - 1] ?? "";
}

/**
 * The offline-queue drain's settle pass (SA-091/SA-091b) — the drain only dequeues a delivered
 * or failed action (`hooks/useNetworkSync.ts`); nothing ever called `markCaptureSettled` for a
 * capture that reached its terminal outcome via the QUEUE rather than a live `onError`/
 * `onSuccess`, which is the SA-091 bug again on the offline path.
 *
 * `records` is pre-classified by the caller (which owns the drain-result types this pure module
 * doesn't import) into exactly the two terminal outcomes worth settling — `useNetworkSync.ts`
 * never includes a still-queued (retried) id here at all, since nothing about it is known yet.
 * The equality guard is why `nonceSuffix` travels per-record instead of just settling by key: if
 * a NEWER attempt already re-minted the pair's nonce (e.g. the operator retried manually while
 * this stale queue entry was still in flight), this drain result belongs to the OLD nonce and
 * must not clear the new one out from under it.
 */
export function settleAfterDrain(
  records: ReadonlyArray<{ customerId: string; orderId: string; nonceSuffix: string }>,
  nonces: NonceMap,
): NonceMap {
  let next = nonces;
  for (const r of records) {
    const key = inlineReturnNonceKey(r.customerId, r.orderId);
    if (next[key] === r.nonceSuffix) next = clearNonce(next, key);
  }
  return next;
}

/** Minimal shape `inlineReturnDrainSettleRecords` needs from a queued action — a structural
 *  subset of `QueuedAction`, kept local so this pure module never imports the offline-queue's
 *  own types. */
export interface InlineReturnDrainAction {
  id: string;
  endpoint: string;
  body?: unknown;
}

/**
 * Builds `settleAfterDrain`'s input from a raw drain result — the ONLY place that decides which
 * of a drain's delivered/failed ids are `/returns/inline/capture` entries worth settling at all,
 * and (for a failed one) whether its failure was a DEFINITE refusal via the same
 * `isDefiniteInlineReturnRefusal` core the direct `onError` path uses. `useNetworkSync.ts` never
 * passes a retried (still-queued) id here in the first place — nothing about it is known yet.
 */
export function inlineReturnDrainSettleRecords(params: {
  delivered: ReadonlyArray<string>;
  failedActions: ReadonlyArray<{ action: InlineReturnDrainAction; reason: string; code?: string }>;
  attempted: ReadonlyArray<InlineReturnDrainAction>;
}): Array<{ customerId: string; orderId: string; nonceSuffix: string }> {
  const CAPTURE_ENDPOINT = "/returns/inline/capture";
  const byId = new Map(params.attempted.map((a) => [a.id, a]));
  const records: Array<{ customerId: string; orderId: string; nonceSuffix: string }> = [];

  const toRecord = (action: InlineReturnDrainAction) => {
    const body = action.body as { customerId?: string; orderId?: string; returnKey?: string };
    if (!body?.customerId || !body?.orderId || !body?.returnKey) return null;
    return {
      customerId: body.customerId,
      orderId: body.orderId,
      nonceSuffix: nonceSuffixFromReturnKey(body.returnKey),
    };
  };

  for (const id of params.delivered) {
    const action = byId.get(id);
    if (!action || action.endpoint !== CAPTURE_ENDPOINT) continue;
    const record = toRecord(action);
    if (record) records.push(record);
  }

  for (const { action, reason, code } of params.failedActions) {
    if (action.endpoint !== CAPTURE_ENDPOINT) continue;
    // `reason` is formatted "HTTP <status>: <message>" (lib/queue-drain.ts) — parse both back
    // out, the same classification core as captureOutcomeFromError.
    const match = /^HTTP (\d+): (.*)$/.exec(reason);
    const status = match ? Number(match[1]) : undefined;
    const message = match ? match[2] : undefined;
    if (!isDefiniteInlineReturnRefusal(status, code, message)) continue;
    const record = toRecord(action);
    if (record) records.push(record);
  }

  return records;
}

/** Settles the direct (non-drain) capture outcome for the attempt identified by the request's
 *  own `returnKey` — pure, so the hook's wiring is testable behaviourally. */
export function settleDirectCapture(
  nonces: NonceMap,
  variables: { customerId: string; orderId: string; returnKey: string },
  outcome: InlineReturnCaptureOutcome | { kind: "queued" },
): NonceMap {
  if (outcome.kind === "queued" || !shouldSettleInlineReturnNonce(outcome)) return nonces;
  return clearNonceIf(
    nonces,
    inlineReturnNonceKey(variables.customerId, variables.orderId),
    nonceSuffixFromReturnKey(variables.returnKey),
  );
}

/** Deterministic id of a direct attempt's failed-action record — one record per returnKey. */
export function directFailureActionId(returnKey: string): string {
  return `direct-inline-return:${returnKey}`;
}

/**
 * A DIRECT capture whose outcome KEEPS the nonce (5xx, a timeout, 408, 429, the retry-409) is in
 * neither the offline queue (api-client only queues no-response errors that are not timeouts)
 * nor `failedActions`. Sign-out empties the nonce store and sign-in rebuilds it only from those
 * two lists, so such an attempt would lose its nonce and the next attempt would mint a NEW key —
 * a second Return if the 5xx actually committed (SA-198). This builds the failed-action record
 * that makes it visible to the sign-in seed (and to the existing failed-action retry surface).
 * Null for a definite refusal (terminal) and for an offline-queued outcome (the queue owns it).
 * `userId` is left to the queue store to stamp.
 */
export function directFailureRecord(
  variables: { customerId: string; orderId: string; returnKey: string },
  error: unknown,
  now: number,
): {
  action: {
    id: string;
    endpoint: string;
    method: "POST";
    body: unknown;
    timestamp: number;
    retries: number;
  };
  reason: string;
  failedAt: number;
} | null {
  const outcome = captureOutcomeFromError(error);
  if (outcome.kind !== "error" || outcome.refused) return null;
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } })
    ?.response;
  const reason =
    response?.status !== undefined
      ? `HTTP ${response.status}: ${typeof response.data?.message === "string" ? response.data.message : ""}`
      : `No response: ${(error as { message?: string })?.message ?? "unknown"}`;
  return {
    action: {
      id: directFailureActionId(variables.returnKey),
      endpoint: "/returns/inline/capture",
      method: "POST",
      body: variables,
      timestamp: now,
      retries: 0,
    },
    reason,
    failedAt: now,
  };
}

/** `useCaptureInlineReturn`'s settle callbacks, built over a `settle(variables, outcome)`
 *  function (the store's `settleCapture`, which also drops every failed-action record for a
 *  settled key) and, optionally, the failed-actions list: a nonce-keeping direct outcome is
 *  recorded there. Kept here so the wiring is a tested unit. */
export function captureSettleHandlers<
  V extends { customerId: string; orderId: string; returnKey: string },
>(
  settle: (variables: V, outcome: InlineReturnCaptureOutcome | { kind: "queued" }) => void,
  failed?: {
    add: (record: NonNullable<ReturnType<typeof directFailureRecord>>) => void;
  },
) {
  return {
    onSuccess: (_data: unknown, variables: V) => {
      settle(variables, { kind: "success" });
    },
    onError: (error: unknown, variables: V) => {
      const outcome = captureOutcomeFromError(error);
      settle(variables, outcome);
      if (!failed || outcome.kind === "queued") return;
      const record = directFailureRecord(variables, error, Date.now());
      if (record) failed.add(record);
    },
  };
}

/**
 * Rebuilds a signed-in user's nonces from THEIR OWN offline queue + failed-actions list. Sign-out
 * always empties the in-memory (and persisted) nonce store — carrying it across users leaked A's
 * customer:order -> nonce to B, who then sent A's returnKey and got A's Return back (Opus review
 * of #1270). A queued capture's nonce, and a FAILED capture with an uncertain outcome (5xx, the
 * retry-409, 408/429, retries exhausted), still matter: the next attempt on that pair must reuse
 * the SAME key or it books a second Return. A definitely-refused failed capture is terminal.
 * The live queue wins over a failed record for the same pair; unstamped legacy entries are
 * adopted, another user's entries are ignored.
 */
export function noncesFromQueues(
  queue: ReadonlyArray<{ endpoint: string; body?: unknown; userId?: string }>,
  failed: ReadonlyArray<{
    action: { endpoint: string; body?: unknown; userId?: string };
    reason: string;
    code?: string;
  }>,
  userId: string,
  /** Returnkeys with a recorded terminal outcome — never restored (stale-record guard). */
  settledReturnKeys: ReadonlyArray<string> = [],
): NonceMap {
  const settled = new Set(settledReturnKeys);
  const out: Record<string, string> = {};
  const take = (a: { endpoint: string; body?: unknown; userId?: string }) => {
    if (a.endpoint !== "/returns/inline/capture") return;
    if (a.userId !== undefined && a.userId !== userId) return;
    const b = a.body as { customerId?: string; orderId?: string; returnKey?: string } | undefined;
    if (!b?.customerId || !b.orderId || !b.returnKey) return;
    if (settled.has(b.returnKey)) return;
    out[inlineReturnNonceKey(b.customerId, b.orderId)] = nonceSuffixFromReturnKey(b.returnKey);
  };
  for (const f of failed) {
    const m = /^HTTP (\d+): (.*)$/.exec(f.reason);
    if (isDefiniteInlineReturnRefusal(m ? Number(m[1]) : undefined, f.code, m ? m[2] : undefined))
      continue;
    take(f.action);
  }
  for (const q of queue) take(q);
  return out;
}

/** A tombstone: a returnKey whose capture reached a TERMINAL outcome (landed / definitely refused). */
export interface SettledKey {
  key: string;
  at: number;
}

export const SETTLED_KEY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const SETTLED_KEY_CAP = 200;

/**
 * Bounds the tombstone list (SA-206/SA-220): a returnKey is unique per attempt, so an old tombstone
 * can no longer matter — and the list is persisted, so it must never grow unbounded. Drops aged
 * entries then evicts oldest-first past `SETTLED_KEY_CAP` — but NEVER a key still referenced by
 * the offline queue or failed-actions list (`protectedKeys`): such an entry can still be
 * replayed/retried, and losing its tombstone would let a stale record resurrect a settled key.
 * Returns the SAME array when nothing changes (cheap no-op set). Called on EVERY insert and at seed.
 */
export function pruneSettledKeys(
  list: ReadonlyArray<SettledKey>,
  now: number,
  protectedKeys: ReadonlySet<string> = new Set(),
): ReadonlyArray<SettledKey> {
  let out = list.filter((t) => protectedKeys.has(t.key) || now - t.at <= SETTLED_KEY_MAX_AGE_MS);
  let excess = out.length - SETTLED_KEY_CAP;
  if (excess > 0) {
    out = out.filter((t) => {
      if (excess > 0 && !protectedKeys.has(t.key)) {
        excess--;
        return false; // oldest-first (the list is insertion-ordered)
      }
      return true;
    });
  }
  return out.length === list.length ? list : out;
}

/** The returnKeys still referenced by the queue or failed-actions list. */
export function referencedReturnKeys(
  queue: ReadonlyArray<{ endpoint: string; body?: unknown }>,
  failed: ReadonlyArray<{ action: { endpoint: string; body?: unknown } }>,
): Set<string> {
  const out = new Set<string>();
  for (const a of [...queue, ...failed.map((f) => f.action)]) {
    if (a.endpoint !== "/returns/inline/capture") continue;
    const k = (a.body as { returnKey?: string } | undefined)?.returnKey;
    if (k) out.add(k);
  }
  return out;
}

/** The wire returnKey a stored nonce-map entry (`customerId:orderId` -> nonce) corresponds to. */
export function returnKeyForNonceEntry(nonceKey: string, nonce: string): string {
  return safeToken(`inl:${nonceKey}:${nonce}`);
}

/** Drops every nonce-map entry whose returnKey has a recorded terminal outcome (tombstone). */
export function dropSettledNonces(
  nonces: NonceMap,
  settledReturnKeys: ReadonlyArray<string>,
): NonceMap {
  if (settledReturnKeys.length === 0) return nonces;
  const settled = new Set(settledReturnKeys);
  const kept: Record<string, string> = {};
  let changed = false;
  for (const [k, n] of Object.entries(nonces)) {
    if (settled.has(returnKeyForNonceEntry(k, n))) changed = true;
    else kept[k] = n;
  }
  return changed ? kept : nonces;
}
