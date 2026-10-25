/**
 * SA-817 (A) 4: ONE submit key per draft, persisted in the draft itself.
 *
 * `POST /orders` replays on its `Idempotency-Key`, so a lost response followed by a resubmit makes ONE order only when the resubmit
 * sends the SAME key. A key held in memory dies with the page (web) or the process (mobile); the key therefore lives in the draft's
 * `payload._submitKey` (the local mirror and the server `SaleDraft`) from the moment the draft is created, and is read back on resume.
 *
 * Pure: no React, no DOM, no network. The API keeps its own literal copy of the field name (it never value-imports this package at
 * runtime); `apps/api/src/drafts/drafts.service.spec.ts` pins the two equal.
 */
export const DRAFT_SUBMIT_KEY_FIELD = "_submitKey";

/** The server's Idempotency-Key header rule: 1-128 printable ASCII characters, no spaces. */
const SUBMIT_KEY_RULE = /^[\x21-\x7e]{1,128}$/;

export function isDraftSubmitKey(value: unknown): value is string {
  return typeof value === "string" && SUBMIT_KEY_RULE.test(value);
}

/** The submit key stored in a draft payload, or null when the draft predates the field or carries something unusable. */
export function readDraftSubmitKey(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const key = (payload as Record<string, unknown>)[DRAFT_SUBMIT_KEY_FIELD];
  return isDraftSubmitKey(key) ? key : null;
}

/** A copy of `payload` carrying `key` as its submit key (every other field untouched). */
export function withDraftSubmitKey<T extends object>(
  payload: T,
  key: string,
): T & { _submitKey: string } {
  return { ...payload, [DRAFT_SUBMIT_KEY_FIELD]: key } as T & { _submitKey: string };
}

/**
 * The key a client must send for the cart in `payload`: the persisted one when the draft has it, else a fresh one from `mint`.
 * Callers store the result back with `withDraftSubmitKey`, so the first autosave of a new draft creates the key.
 */
export function resolveDraftSubmitKey(payload: unknown, mint: () => string): string {
  return readDraftSubmitKey(payload) ?? mint();
}
