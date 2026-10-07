import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
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
}

const NO_COUNTER: CounterSaleGate = {
  showButton: false,
  opensAsCounter: false,
  offerShipInstead: false,
};

/** always -> the button and New order opens as the counter; optional -> the button only; off / unknown / loading -> nothing. */
export function counterSaleGate(cap: FulfilmentCapability | null | undefined): CounterSaleGate {
  if (!cap) return NO_COUNTER;
  if (cap.counter === "optional")
    return { showButton: true, opensAsCounter: false, offerShipInstead: false };
  if (cap.counter === "always")
    return {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: (cap.methods ?? []).includes("SHIP"), // `?? []`: a partial answer must not crash the till
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
]);

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
  if (status === 401 || status === 403)
    return "You don't have permission to complete a counter sale.";
  const final = finalCounterSaleCopy(err);
  if (final) return final;
  if (status === 409 && ORDER_EXISTS_CODES.has(res?.data?.code))
    return COUNTER_OUTCOME_UNKNOWN_COPY; // the order exists
  if (status === 409 && res?.data?.code === API_ERROR_CODES.WALK_IN_OPEN_CREDIT)
    return "This walk-in has open credit. Resolve it on the customer, then ring the sale again.";
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
/** The storage key for one signed-in tenant + user, or null when either is unknown (then nothing is stored or restored). */
export function heldAttemptKey(tenant?: string | null, userId?: string | null): string | null {
  return tenant && userId ? `${HELD_ATTEMPT_KEY}:${tenant}:${userId}` : null;
}
const isNum = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
const optNum = (n: unknown): boolean => n === undefined || isNum(n);
function validLine(l: unknown): boolean {
  if (!l || typeof l !== "object") return false;
  const o = l as Record<string, unknown>;
  return (
    typeof o.productId === "string" &&
    !!o.productId &&
    isNum(o.qty) &&
    isNum(o.unitPrice) &&
    optNum(o.boxes) &&
    optNum(o.pieces) &&
    optNum(o.unitsPerBox)
  );
}
function validCustomer(c: unknown): boolean {
  if (c === null || c === undefined) return true;
  if (typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.businessName === "string";
}
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
    window.sessionStorage.removeItem(storeKey);
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
