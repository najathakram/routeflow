/**
 * SA-824: the wire shape of the payment Idempotency-Key answers (GET /invoices/payments/by-key/:key and
 * POST /invoices/payments/by-key/:key/resolve). One declaration for the api, the web and the mobile clients.
 */

import type { PaymentIdempotencyScope } from "./enums";

/**
 * The three money-in writers that claim a payment key. Derived from the parity-pinned
 * `PAYMENT_IDEMPOTENCY_SCOPE_VALUES` (api/enums.ts), never hand-typed (L-072).
 */
export type PaymentKeyScope = PaymentIdempotencyScope;

/** The `state` literals of a definitive answer. */
export const PAYMENT_KEY_ANSWER_STATE = {
  FOUND: "found",
  TOMBSTONED: "tombstoned",
} as const;

export type PaymentKeyAnswerState =
  (typeof PAYMENT_KEY_ANSWER_STATE)[keyof typeof PAYMENT_KEY_ANSWER_STATE];

/** A recorded payment: the stored result with CURRENT statuses, the scope, and `replayed: true`. */
export type PaymentKeyFound = {
  state: typeof PAYMENT_KEY_ANSWER_STATE.FOUND;
  scope: PaymentKeyScope;
  replayed: true;
} & Record<string, unknown>;

/** Resolved with nothing recorded: the key is closed and a late Save under it is refused. */
export type PaymentKeyTombstoned = { state: typeof PAYMENT_KEY_ANSWER_STATE.TOMBSTONED };

export type PaymentKeyAnswer = PaymentKeyFound | PaymentKeyTombstoned;
