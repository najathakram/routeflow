import { computeLineSubtotal, roundMoney, validCustomer, validLine } from "@routeflow/pricing";
import {
  API_ERROR_CODES,
  type CounterSalePaymentMethod,
  type FulfilmentCapability,
} from "@routeflow/types";

/**
 * Counter sale (walk-in pickup) — the pure logic behind the one screen. Money goes ONLY through @routeflow/pricing
 * (`computeLineSubtotal`, `roundMoney`); there is no ad-hoc rounding here.
 */

export interface CounterSaleGate {
  /** the "Counter sale" button (Orders + dashboard) */
  showButton: boolean;
  /** staff "New order" opens AS the counter sale */
  opensAsCounter: boolean;
  /** "Ship this order instead": only when SHIP is a method of this business */
  offerShipInstead: boolean;
  /** "Invoice order": a store-only business's way into the order builder (row 331) */
  offerInvoiceOrder: boolean;
}

const NO_COUNTER: CounterSaleGate = {
  showButton: false,
  opensAsCounter: false,
  offerShipInstead: false,
  offerInvoiceOrder: false,
};

/**
 * A store-only business: PICKUP is its only fulfilment method (no route, no shipping). Read from
 * `capabilities.fulfilment`, never from the profile key; a missing or partial answer is NOT store-only.
 */
export function isStoreOnly(
  cap: Pick<FulfilmentCapability, "methods"> | null | undefined,
): boolean {
  const methods = (cap?.methods ?? []) as readonly string[];
  return methods.length > 0 && methods.every((m) => m === "PICKUP");
}

/** always -> the button and New order opens as the counter; optional -> the button only; off / unknown / loading -> nothing. */
export function counterSaleGate(cap: FulfilmentCapability | null | undefined): CounterSaleGate {
  if (!cap) return NO_COUNTER;
  if (cap.counter === "optional")
    return {
      showButton: true,
      opensAsCounter: false,
      offerShipInstead: false,
      offerInvoiceOrder: false,
    };
  if (cap.counter === "always")
    return {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: (cap.methods ?? []).includes("SHIP"), // `?? []`: a partial answer must not crash the till
      // A business with no delivery at all has nowhere else to build an invoiced order from: give it the entry.
      offerInvoiceOrder: isStoreOnly(cap),
    };
  return NO_COUNTER;
}

/**
 * Mirrors the server resolver: the CUSTOMER's stored path is used only if it is one of `capability.methods`, otherwise
 * `capability.staffDefault`. A stored ROUTE on a ship-only business therefore preselects SHIP.
 */
export function preselectFulfilment(
  customerPath: string | null | undefined,
  cap: Pick<FulfilmentCapability, "methods" | "staffDefault"> | null | undefined,
): string | null {
  if (!cap) return null;
  if (customerPath && ((cap.methods ?? []) as readonly string[]).includes(customerPath))
    return customerPath;
  return cap.staffDefault;
}

export interface CartLine {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

/** Subtotal = the sum of each line's `computeLineSubtotal`; tax = one `roundMoney` of the subtotal; total = their sum. */
export function cartTotals(
  lines: readonly CartLine[],
  taxRate: number,
): { subtotal: number; tax: number; total: number } {
  const subtotal = roundMoney(
    lines.reduce(
      (sum, l) =>
        sum +
        computeLineSubtotal({
          unitPrice: l.unitPrice,
          qty: l.qty,
          boxes: l.boxes ?? undefined,
          pieces: l.pieces ?? undefined,
          unitsPerBox: l.unitsPerBox ?? undefined,
        }),
      0,
    ),
  );
  const tax = roundMoney(subtotal * taxRate);
  return { subtotal, tax, total: roundMoney(subtotal + tax) };
}

export interface QuickTender {
  label: string;
  amount: number;
  disabled: boolean;
}

/** Exact / $20 / $50 / $100; a bill smaller than the total is disabled. */
export function quickTenderOptions(total: number): QuickTender[] {
  return [
    { label: "Exact", amount: roundMoney(total), disabled: false },
    ...[20, 50, 100].map((amount) => ({
      label: `$${amount}`,
      amount,
      disabled: amount < total,
    })),
  ];
}

/** Change owed for a tender, in cents; never negative. */
export function changeDue(total: number, tendered: number): number {
  return Math.max(0, roundMoney(tendered - total));
}

/** What is still owed for a tender, in cents; never negative. Zero exactly when `changeDue` takes over. */
export function amountDue(total: number, tendered: number): number {
  return Math.max(0, roundMoney(total - tendered));
}

export interface PaymentMethodOption {
  method: CounterSalePaymentMethod;
  label: string;
  disabled: boolean;
}

/** Cash / Card / Check / On account; On account is disabled for a walk-in (no account to charge). */
export function paymentMethodOptions(isWalkIn: boolean): PaymentMethodOption[] {
  return [
    { method: "CASH", label: "Cash", disabled: false },
    { method: "CARD", label: "Card", disabled: false },
    { method: "CHECK", label: "Check", disabled: false },
    { method: "ON_ACCOUNT", label: "On account", disabled: isWalkIn },
  ];
}

export type PaymentProblem = "TENDER_SHORT" | "CHECK_NUMBER_REQUIRED" | "WALK_IN_ON_ACCOUNT";

export function validatePayment(input: {
  method: CounterSalePaymentMethod;
  total: number;
  tendered?: number;
  reference?: string;
  isWalkIn: boolean;
}): PaymentProblem | null {
  if (input.method === "ON_ACCOUNT" && input.isWalkIn) return "WALK_IN_ON_ACCOUNT";
  if (input.method === "CASH" && !(Number(input.tendered ?? 0) >= input.total))
    return "TENDER_SHORT";
  if (input.method === "CHECK" && !(input.reference ?? "").trim()) return "CHECK_NUMBER_REQUIRED";
  return null;
}

export const PAYMENT_PROBLEM_COPY: Record<PaymentProblem, string> = {
  TENDER_SHORT: "The amount tendered is less than the total.",
  CHECK_NUMBER_REQUIRED: "Enter the check number.",
  WALK_IN_ON_ACCOUNT:
    "A walk-in customer can't be charged on account. Pick a customer or another payment method.",
};

/** The scan field: 1-3 digits are a QUANTITY to multiply the next scan by; anything else is a code. */
export function parseScanField(
  raw: string,
): { kind: "qty"; qty: number } | { kind: "code"; code: string } {
  const text = raw.trim();
  if (/^\d{1,3}$/.test(text) && Number(text) > 0) return { kind: "qty", qty: Number(text) };
  return { kind: "code", code: text };
}

export const COUNTER_SALES_DISABLED_COPY = "Counter sales are not turned on for this business.";

/** Shown under the unknown-outcome banner when "Check sale status" itself failed (anything but a 404 answer). */
export const COUNTER_LOOKUP_FAILED_COPY = "Couldn't check the sale. Try again.";

/** After a 5xx, a network error or a timeout the sale may or may not have been written: say exactly that. */
export const COUNTER_OUTCOME_UNKNOWN_COPY =
  "We couldn't confirm the sale. Check recent sales before trying again.";

const DEFINITIVE_REFUSALS = new Set([400, 401, 403, 404, 409, 422, 429]);

/** 409 codes that mean the order EXISTS (the key was already used): an unknown outcome, never a refusal. */
const ORDER_EXISTS_CODES: ReadonlySet<unknown> = new Set([
  API_ERROR_CODES.COUNTER_SALE_ORDER_CHANGED,
  API_ERROR_CODES.IDEMPOTENCY_KEY_OTHER_ORDER,
  API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH,
  // The sale is committed BEFORE its tender: a tender dated inside a closed day is refused afterwards, so the sale exists
  // (unpaid). A fresh key would ring it twice; the SAME key finishes it once the close is reopened.
  API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
]);

/** 409 COUNTER_SALE_DAY_CLOSED from the till's sale: the sale is saved, only its payment was refused (the tender's day is closed). */
export const COUNTER_SALE_DAY_CLOSED_TILL_COPY =
  "This day is closed, so no payment was taken. The sale is saved. Ask the office to reopen the close, then use Try again.";

/**
 * True only for a 4xx that PROVES nothing was written (the auth guard, the throttler and validation all reject BEFORE the
 * handler runs), and only for a FIRST attempt: once an attempt has been UNKNOWN, no refusal is definitive (the first try may
 * have committed); only a 2xx or the by-key lookup's 404 COUNTER_SALE_NOT_FOUND settles it. Every other failure (5xx,
 * network, timeout, 408) is unknown, and so is a 409 whose code says the order exists.
 */
export function isDefinitiveCounterSaleRefusal(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  if (res?.status === 409 && ORDER_EXISTS_CODES.has(res.data?.code)) return false;
  return typeof res?.status === "number" && DEFINITIVE_REFUSALS.has(res.status);
}

/** The by-key lookup's one definitive "no": a 404 with COUNTER_SALE_NOT_FOUND. Any other failure proves nothing. */
export function isCounterSaleNotFound(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  return res?.status === 404 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_NOT_FOUND;
}

/** The one copy for a voided / cancelled counter sale (409 COUNTER_SALE_VOIDED). FINAL: the till never retries it. */
export const COUNTER_SALE_VOIDED_COPY = "Voided — start a new sale";

/** 409 COUNTER_SALE_VOIDED: the sale was voided or cancelled after it was rung. */
export function isCounterSaleVoided(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_VOIDED;
}

/** The one copy for a sale staff changed after it was rung (409 COUNTER_SALE_CHANGED). FINAL: the till never retries it. */
export const COUNTER_SALE_CHANGED_COPY =
  "This sale was changed after it was rung — check with the office.";

/** 409 COUNTER_SALE_CHANGED: the sale exists but staff changed it after it was rung. */
export function isCounterSaleChanged(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_CHANGED;
}

/** The fixed copy of a FINAL answer (voided / changed after it was rung), else null: such a sale is never retried. */
export function finalCounterSaleCopy(err: unknown): string | null {
  if (isCounterSaleVoided(err)) return COUNTER_SALE_VOIDED_COPY;
  if (isCounterSaleChanged(err)) return COUNTER_SALE_CHANGED_COPY;
  return null;
}

/** The by-key lookup's 409 COUNTER_SALE_INCOMPLETE: the sale was half-written, so re-POST with the SAME key to finish it. */
export function isCounterSaleIncomplete(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_INCOMPLETE;
}

/** POS-5: 403 PRICE_EDIT_NOT_PERMITTED (an edited price from a caller who may not change prices). Nothing was written. */
export const COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY =
  "You can't change prices. Use Reset price on the edited lines, or ask your account admin.";

/**
 * FIXED copy by status (and the one named 403 code); the server's own message is never shown. "Nothing was charged" is
 * said ONLY for a refusal that proves nothing was written; a 5xx / network error / timeout is an unknown outcome.
 */
export function counterSaleErrorCopy(err: unknown): string {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  const status = res?.status;
  if (status === 403 && res?.data?.code === API_ERROR_CODES.COUNTER_SALES_DISABLED)
    return COUNTER_SALES_DISABLED_COPY;
  // POS-5: a refused price edit says so (and what to do), before the generic permission copy below.
  if (status === 403 && res?.data?.code === API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED)
    return COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY;
  if (status === 401 || status === 403)
    return "You don't have permission to complete a counter sale.";
  const final = finalCounterSaleCopy(err);
  if (final) return final;
  if (status === 409 && res?.data?.code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)
    return COUNTER_SALE_DAY_CLOSED_TILL_COPY;
  if (status === 409 && ORDER_EXISTS_CODES.has(res?.data?.code))
    return COUNTER_OUTCOME_UNKNOWN_COPY; // the order exists
  if (status === 409 && res?.data?.code === API_ERROR_CODES.WALK_IN_OPEN_CREDIT)
    return "This walk-in has open credit. Resolve it on the customer, then ring the sale again.";
  // B1209: a walk-in's cash below the server's total was refused (400, as pickup-complete) BEFORE anything was written.
  if (status === 400 && res?.data?.code === API_ERROR_CODES.COUNTER_TENDER_SHORT)
    return PICKUP_TENDER_SHORT_COPY;
  if (status === 409 && res?.data?.code === API_ERROR_CODES.COUNTER_SALE_KEY_CONFLICT)
    return "That sale reference was already used. Ring the sale again.";
  if (status === 409)
    return "Something changed while you were checking out. Review the sale and try again. Nothing was charged.";
  if (status === 400 || status === 404 || status === 422 || status === 429)
    return "This sale can't be completed as entered. Check the items and payment and try again.";
  return COUNTER_OUTCOME_UNKNOWN_COPY;
}

/** One key per SALE (sent as `Idempotency-Key`): kept until a DEFINITIVE answer, then a new sale gets a new one. */
export function newIdempotencyKey(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // insecure-context fallback (a counter on a plain-http LAN address has no randomUUID)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Per-DEVICE preference ("Print receipt automatically"): localStorage only, never tenant data, never throws. */
export const AUTO_PRINT_KEY = "rf.counterSale.autoPrint";
export function readAutoPrint(): boolean {
  try {
    return window.localStorage.getItem(AUTO_PRINT_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeAutoPrint(on: boolean): void {
  try {
    window.localStorage.setItem(AUTO_PRINT_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the toggle simply does not persist */
  }
}

// ─── Pickup complete (order ahead, "Picked up") ───────────────────────────────────────────────────────────

/**
 * What is left to collect at the hand-over, BEFORE the call: the sum of the server's per-invoice `balanceDue` over the
 * order's live (not VOID / WRITTEN_OFF) invoices; with no invoice yet, the order total. The order payload carries no paid figure, so
 * the dialog reads each invoice's detail for `balanceDue`. Cents via `roundMoney`; the server still judges the real
 * balance (it never over-collects), this only decides whether to ask for a tender.
 */
/** Invoices that owe nothing and are never collected on: VOID and WRITTEN_OFF. */
export const PICKUP_DEAD_INVOICE: ReadonlySet<string> = new Set(["VOID", "WRITTEN_OFF"]);

export function pickupBalanceDue(
  orderTotal: number,
  invoices: ReadonlyArray<{ status: string; total: number; balanceDue?: number }>,
): number {
  const live = invoices.filter((inv) => !PICKUP_DEAD_INVOICE.has(inv.status));
  if (live.length === 0) return roundMoney(orderTotal);
  return roundMoney(live.reduce((sum, inv) => sum + (inv.balanceDue ?? inv.total), 0));
}

export const PICKUP_NOT_READY_COPY =
  "This order isn't ready for pickup yet. Confirm it and mark it ready first.";
export const PICKUP_ONLY_COPY = "Only a pickup order can be handed over this way.";
export const PICKUP_GENERIC_COPY = "Couldn't complete the pickup. Check the order and try again.";

/** 409 COUNTER_SALE_DAY_CLOSED from pickup-complete: the hand-over stands, only the payment was refused (the tender's day is closed). */
export const PICKUP_DAY_CLOSED_COPY =
  "Handed over. Payment not taken: the till for that day is closed.";
export const PICKUP_PAYMENT_REQUIRED_COPY =
  "A balance is due on this order now. Take payment to finish.";
export const PICKUP_TENDER_SHORT_COPY = "A walk-in customer must pay the full balance.";
export const PICKUP_KEY_CONFLICT_COPY = "Already picked up. Record any payment on the invoice.";
export const PICKUP_INVOICE_MISSING_COPY =
  "The order may be picked up, but its invoice isn't ready yet. Retry to finish.";
export const PICKUP_WALK_IN_CREDIT_COPY =
  "This walk-in has open credit. Resolve it on the customer before handing over.";

/** The API error code of a failed pickup-complete call, if any. */
export function pickupErrorCode(err: unknown): string | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === "string" ? code : undefined;
}

/** Fixed copy by error code; the server's own message is never shown. */
export function pickupCompleteErrorCopy(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  if (res?.data?.code === API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED)
    return PICKUP_PAYMENT_REQUIRED_COPY;
  if (res?.data?.code === API_ERROR_CODES.COUNTER_TENDER_SHORT) return PICKUP_TENDER_SHORT_COPY;
  if (res?.data?.code === API_ERROR_CODES.PICKUP_KEY_CONFLICT) return PICKUP_KEY_CONFLICT_COPY;
  if (res?.data?.code === API_ERROR_CODES.PICKUP_INVOICE_MISSING)
    return PICKUP_INVOICE_MISSING_COPY;
  if (res?.data?.code === API_ERROR_CODES.WALK_IN_OPEN_CREDIT) return PICKUP_WALK_IN_CREDIT_COPY;
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)
    return PICKUP_DAY_CLOSED_COPY;
  if (res?.data?.code === API_ERROR_CODES.PICKUP_NOT_READY) return PICKUP_NOT_READY_COPY;
  if (res?.data?.code === API_ERROR_CODES.PICKUP_ONLY) return PICKUP_ONLY_COPY;
  if (res?.data?.code === API_ERROR_CODES.WALK_IN_NO_ACCOUNT)
    return PAYMENT_PROBLEM_COPY.WALK_IN_ON_ACCOUNT;
  if (res?.data?.code === API_ERROR_CODES.COUNTER_CHECK_NUMBER_REQUIRED)
    return PAYMENT_PROBLEM_COPY.CHECK_NUMBER_REQUIRED;
  return PICKUP_GENERIC_COPY;
}

/**
 * The ONE held attempt (Idempotency-Key + body + the cart the clerk rang), kept in sessionStorage while its outcome is
 * UNKNOWN so leaving the screen and coming back restores the locked sale with the same key. Per tab; every access is guarded.
 */
export const HELD_ATTEMPT_KEY = "rf.counterSale.heldAttempt";
export interface HeldAttemptSnapshot {
  key: string;
  dto: unknown;
  next: boolean;
  estimate: { total: number; change: number };
  lines: unknown[];
  customer: unknown;
  method: string;
  tendered: string;
  reference: string;
}
/** Shown with the Discard button: the unreadable held sale may already have been written. */
export const COUNTER_DISCARD_COPY =
  "The previous sale may have gone through. Check recent sales before ringing it again.";
/** The storage key for one signed-in tenant + user, or null when either is unknown (then nothing is stored or restored). */
export function heldAttemptKey(tenant?: string | null, userId?: string | null): string | null {
  return tenant && userId ? `${HELD_ATTEMPT_KEY}:${tenant}:${userId}` : null;
}
// The two shape checks live in @routeflow/pricing (the park contract shares them with the API); re-exported so every caller
// of the held-attempt snapshot keeps importing them from here.
export { validLine, validCustomer } from "@routeflow/pricing";
/**
 * The held attempt, null when none is stored, or "corrupt" when something IS stored but is not a valid attempt: the payload is
 * dropped and the caller must keep the sale LOCKED as "outcome unknown" (never silently unlock: a sale may have been written).
 */
export function readHeldAttempt(storeKey: string | null): HeldAttemptSnapshot | "corrupt" | null {
  if (!storeKey) return null;
  try {
    const raw = window.sessionStorage.getItem(storeKey);
    if (!raw) return null;
    let ok = false;
    let v: Partial<HeldAttemptSnapshot> | null = null;
    try {
      v = JSON.parse(raw) as Partial<HeldAttemptSnapshot> | null;
      ok =
        !!v &&
        typeof v.key === "string" &&
        !!v.key &&
        !!v.dto &&
        typeof v.dto === "object" &&
        Array.isArray(v.lines) &&
        v.lines.every(validLine) &&
        typeof v.method === "string" &&
        validCustomer(v.customer);
    } catch {
      ok = false;
    }
    if (ok) return v as HeldAttemptSnapshot;
    // Keep a payload-free marker (never delete): a reload must stay LOCKED until the cashier discards.
    try {
      window.sessionStorage.setItem(storeKey, JSON.stringify({ state: "unknown" }));
    } catch {
      // The marker could not be written: the invalid payload is still stored, so a reload reads it
      // as corrupt again. Never fall through to null (that would unlock the till).
    }
    return "corrupt";
  } catch {
    return null;
  }
}
export function writeHeldAttempt(storeKey: string | null, snap: HeldAttemptSnapshot): void {
  if (!storeKey) return;
  try {
    // Only what the till re-renders: never the customer's email, phone, address or any other field.
    const c = snap.customer as Record<string, unknown> | null | undefined;
    const customer = c
      ? Object.fromEntries(
          (["id", "businessName", "pricingTier", "fulfillPath"] as const)
            .filter((k) => c[k] !== undefined)
            .map((k) => [k, c[k]]),
        )
      : null;
    window.sessionStorage.setItem(storeKey, JSON.stringify({ ...snap, customer }));
  } catch {
    /* storage unavailable: the attempt is still held in memory */
  }
}
export function clearHeldAttempt(storeKey: string | null): void {
  if (!storeKey) return;
  try {
    window.sessionStorage.removeItem(storeKey);
  } catch {
    /* nothing to clear */
  }
}

/** Pickup codes the pickup dialog answers with its own fixed copy: the global error toast stays quiet for these. */
const PICKUP_HANDLED_CODES: ReadonlySet<string> = new Set([
  API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED,
  API_ERROR_CODES.COUNTER_TENDER_SHORT,
  API_ERROR_CODES.PICKUP_KEY_CONFLICT,
  API_ERROR_CODES.PICKUP_INVOICE_MISSING,
  API_ERROR_CODES.WALK_IN_OPEN_CREDIT,
  API_ERROR_CODES.WALK_IN_NO_ACCOUNT,
  API_ERROR_CODES.COUNTER_CHECK_NUMBER_REQUIRED,
  API_ERROR_CODES.PICKUP_NOT_READY,
  API_ERROR_CODES.PICKUP_ONLY,
  API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
]);
export function isPickupHandledError(err: unknown): boolean {
  const code = pickupErrorCode(err);
  return code !== undefined && PICKUP_HANDLED_CODES.has(code);
}

/**
 * The Idempotency-Key of a pickup whose outcome is UNKNOWN, kept in sessionStorage (per tab) so a reload of the order page
 * retries with the SAME key. Scoped to tenant + user + order; every access is guarded and the value is validated on read.
 */
export const HELD_PICKUP_KEY = "rf.pickup.heldKey";
export function heldPickupStoreKey(
  tenant?: string | null,
  userId?: string | null,
  orderId?: string | null,
): string | null {
  return tenant && userId && orderId ? `${HELD_PICKUP_KEY}:${tenant}:${userId}:${orderId}` : null;
}
export function readHeldPickupKey(storeKey: string | null): string | null {
  if (!storeKey) return null;
  try {
    const raw = window.sessionStorage.getItem(storeKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as { key?: unknown } | null;
    if (v && typeof v.key === "string" && v.key.length > 0 && v.key.length <= 200) return v.key;
    window.sessionStorage.removeItem(storeKey);
    return null;
  } catch {
    return null;
  }
}
export function writeHeldPickupKey(storeKey: string | null, key: string): void {
  if (!storeKey) return;
  try {
    window.sessionStorage.setItem(storeKey, JSON.stringify({ key }));
  } catch {
    /* storage unavailable: the key is still held in memory */
  }
}
export function clearHeldPickupKey(storeKey: string | null): void {
  if (!storeKey) return;
  try {
    window.sessionStorage.removeItem(storeKey);
  } catch {
    /* nothing to clear */
  }
}
