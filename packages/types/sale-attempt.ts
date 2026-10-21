import { API_ERROR_CODES } from "./api/error-codes";

/**
 * Row 485: the ONE retry rule for a sale ring (web counter + New sale, mobile New sale). A sale call
 * (`POST /orders/counter-sale`, `POST /orders/sell`) carries an `Idempotency-Key` that is minted once per
 * attempt and reused on every retry of it; the server then replays the stored order instead of writing a
 * second one (Order has a unique (tenantId, idempotencyKey)). The key is dropped ONLY on a definitive outcome:
 * a success, or a refusal that proves nothing was written. Pure: no React, no DOM, no network.
 */

/** 4xx statuses the guard, the throttler or validation produce BEFORE the handler writes anything. */
const DEFINITIVE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 422, 429,
]);

/** 409 codes that mean the order EXISTS (the key was already used): an unknown outcome, never a refusal. */
export const SALE_ORDER_EXISTS_CODES: ReadonlySet<unknown> = new Set([
  API_ERROR_CODES.COUNTER_SALE_ORDER_CHANGED,
  API_ERROR_CODES.IDEMPOTENCY_KEY_OTHER_ORDER,
  API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH,
  // The sale is committed BEFORE its tender: a tender dated inside a closed day is refused afterwards, so the sale exists
  // (unpaid). A fresh key would ring it twice; the SAME key finishes it once the close is reopened.
  API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
]);

interface ErrorBody {
  code?: unknown;
  invoiceId?: unknown;
  orderId?: unknown;
}
type ApiErrorLike = { response?: { status?: unknown; data?: ErrorBody } } | null | undefined;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** True when the error body names a committed invoice or order (row 466): the sale EXISTS. */
export function namesCommittedSale(err: unknown): boolean {
  const data = (err as ApiErrorLike)?.response?.data;
  return nonEmpty(data?.invoiceId) || nonEmpty(data?.orderId);
}

/**
 * True only for a 4xx that PROVES nothing was written, and only when the body names no committed order or
 * invoice. Every other failure (5xx, network, timeout, 408, a 409 whose code says the order exists, any body
 * with an orderId/invoiceId) is an UNKNOWN outcome: the key is kept for the retry.
 */
export function isDefinitiveSaleRefusal(err: unknown): boolean {
  const res = (err as ApiErrorLike)?.response;
  if (res?.status === 409 && SALE_ORDER_EXISTS_CODES.has(res.data?.code)) return false;
  if (namesCommittedSale(err)) return false;
  return typeof res?.status === "number" && DEFINITIVE_REFUSAL_STATUSES.has(res.status);
}

/** The key held for one sale attempt, bound to the cart/form it was minted for. */
export interface HeldSaleKey {
  key: string;
  fingerprint: string;
}

/**
 * The key to send now. The held key is reused while the cart/form is unchanged (a retry of the same attempt);
 * a different fingerprint, or nothing held, mints a new one (a new attempt).
 */
export function saleAttemptKey(
  held: HeldSaleKey | null,
  fingerprint: string,
  mint: () => string,
): HeldSaleKey {
  return held && held.fingerprint === fingerprint ? held : { key: mint(), fingerprint };
}

/** What to hold after a call settles: nothing on a success or a definitive refusal, else the same key. */
export function heldAfterSale(
  held: HeldSaleKey,
  outcome: { ok: true } | { ok: false; error: unknown },
): HeldSaleKey | null {
  if (outcome.ok) return null;
  return isDefinitiveSaleRefusal(outcome.error) ? null : held;
}

/** A v4-shaped id for the key. `Math.random` is enough (uniqueness per attempt, not secrecy) and works on Hermes. */
export function mintSaleKey(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** What an UNKNOWN sale outcome names, if anything: the committed order and/or invoice (row 466). */
export interface UnknownSale {
  invoiceId: string | null;
  orderId: string | null;
}

/** Where "open it" goes for an unknown sale: the invoice, else the order, else the recent-orders list. */
export type SaleRecovery =
  { kind: "invoice"; id: string } | { kind: "order"; id: string } | { kind: "recent" };

export function saleRecovery(unknown: UnknownSale): SaleRecovery {
  if (unknown.invoiceId) return { kind: "invoice", id: unknown.invoiceId };
  if (unknown.orderId) return { kind: "order", id: unknown.orderId };
  return { kind: "recent" };
}

/**
 * The ONE copy for an unknown sale outcome, shared by web and mobile so the screens cannot diverge. While the
 * outcome is unknown the cart is locked; the clerk can try again (same key), open what exists, or start a new
 * sale after an explicit confirm (which tells them to check recent orders first).
 */
export const SALE_RECOVERY_COPY = {
  title: "Sale not confirmed",
  /** The lead sentence; the closing clause follows the action offered (see saleRecoveryBody). */
  body: "We couldn't confirm this sale. It may already be recorded, so the cart is locked. Try again to finish it, or",
  bodyOrder: "open the order to check.",
  bodyInvoice: "open the invoice to check.",
  bodyRecent: "check recent orders.",
  tryAgain: "Try again",
  openOrder: "Open order",
  openInvoice: "Open invoice",
  recentOrders: "Check recent orders",
  startNew: "Start a new sale",
  confirmTitle: "Start a new sale?",
  confirmBody:
    "Check recent orders first. If this sale was recorded, starting a new one rings it up twice.",
  confirmKeep: "Keep this sale",
} as const;

/** The full body line, its closing clause matching the one action offered (invoice, order, or recent orders). */
export function saleRecoveryBody(unknown: UnknownSale): string {
  const r = saleRecovery(unknown);
  const end =
    r.kind === "invoice"
      ? SALE_RECOVERY_COPY.bodyInvoice
      : r.kind === "order"
        ? SALE_RECOVERY_COPY.bodyOrder
        : SALE_RECOVERY_COPY.bodyRecent;
  return `${SALE_RECOVERY_COPY.body} ${end}`;
}

const idOrNull = (v: unknown): string | null => (nonEmpty(v) ? v : null);

/**
 * The holder a screen keeps for one sale form.
 *  - `keyFor(fingerprint)`: the held key while the cart/form is unchanged, or while the outcome is UNKNOWN (the
 *    cart is locked then, so a changed fingerprint cannot be a deliberate edit); a new key otherwise.
 *  - `settle(outcome)`: a success or a definitive refusal clears the key and the lock; anything else keeps the
 *    key and LOCKS the sale as unknown, recording the order/invoice the error body names.
 *  - `unknown()`: the lock (null when unlocked). `startNew()`: the clerk confirmed a new sale, so clear both.
 */
export function createSaleKeyHolder(mint: () => string = mintSaleKey) {
  let held: HeldSaleKey | null = null;
  let unknown: UnknownSale | null = null;
  return {
    keyFor(fingerprint: string): string {
      held = unknown && held ? held : saleAttemptKey(held, fingerprint, mint);
      return held.key;
    },
    settle(outcome: { ok: true } | { ok: false; error: unknown }): void {
      if (!held) return;
      held = heldAfterSale(held, outcome);
      if (!held || outcome.ok) {
        held = null;
        unknown = null;
        return;
      }
      const data = (outcome.error as ApiErrorLike)?.response?.data;
      unknown = { invoiceId: idOrNull(data?.invoiceId), orderId: idOrNull(data?.orderId) };
    },
    unknown(): UnknownSale | null {
      return unknown;
    },
    startNew(): void {
      held = null;
      unknown = null;
    },
    /** The key currently held, or null once a definitive outcome cleared it. */
    peek(): string | null {
      return held ? held.key : null;
    },
  };
}
