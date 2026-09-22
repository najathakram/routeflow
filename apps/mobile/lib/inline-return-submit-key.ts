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
 * IDENTITY = customerId + orderId (the CARRYING order) + the sorted `productId:boxes:pieces`
 * triples + a per-attempt NONCE (never the reason/note — the same goods going back on the same
 * order are the same capture attempt whether or not the reason chip changed before a retry).
 *
 * THE NONCE IS THE WHOLE POINT, AND IT IS SUBTLE: it must be PERSISTED and RE-READ, never
 * reminted on relaunch — a reminted nonce on every replay defeats the pattern entirely (see
 * `inlineReturnSubmissionStore.ts`, which does the actual persisting; this file holds ONLY the
 * pure key derivation + nonce-map reducer logic, tested here without any AsyncStorage/zustand
 * dependency, per this project's mobile-tests-are-pure-logic-only convention — see
 * `returns-logic.ts#submittedReturnKey` for the same split on the standard-return flow).
 *
 * SA-071b §8.1a(5) interaction, worth being explicit about: because `items` is part of the
 * hashed identity, a re-quote that CHANGES the submitted quantities (option 3's re-quote path,
 * synced via `applyCoveredPiecesToState`) produces a DIFFERENT key — correctly, since a
 * different quantity set is a genuinely different capture, not a replay of the same one. An
 * edit-then-resubmit is a NEW attempt, not a replay of the old one; only an identical retry of
 * the SAME quantities collapses onto the prior attempt.
 */

/** Header/body-safe: every real component is a UUID or a small integer, so this never fires in
 *  practice — here so a surprising id can never produce something the wire can't carry. */
function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9:,._-]/g, "_");
}

export interface InlineReturnSubmitKeyItem {
  productId: string;
  boxes: number;
  pieces: number;
}

export interface InlineReturnSubmitKeyInput {
  customerId: string;
  orderId: string;
  items: ReadonlyArray<InlineReturnSubmitKeyItem>;
}

/** The stable lookup key for the nonce map — identifies the (customer, carrying order) pair
 *  an in-flight attempt belongs to, independent of the quantities being requested (those can
 *  change across a re-quote without starting a new attempt). */
export function inlineReturnNonceKey(customerId: string, orderId: string): string {
  return `${customerId}:${orderId}`;
}

/** The actual `returnKey` sent on the wire for one attempt at one quantity set. */
export function inlineReturnSubmitKey(input: InlineReturnSubmitKeyInput, nonce: string): string {
  const pairs = [...input.items]
    .map((i) => `${i.productId}:${i.boxes}:${i.pieces}`)
    .sort()
    .join(",");
  return safeToken(`inl:${input.customerId}:${input.orderId}:${pairs}:${nonce}`);
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
