import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES, type CounterSalePaymentMethod } from "@routeflow/types";

/**
 * Counter sale (walk-in pickup) — the pure logic behind the one screen. Money goes ONLY through @routeflow/pricing
 * (`computeLineSubtotal`, `roundMoney`); there is no ad-hoc rounding here.
 */

/**
 * The slice of `capabilities.fulfilment` (GET /tenants/me/features) this screen reads. Structural on purpose: the shared type
 * (`packages/types/api/fulfilment.ts`, U-units) replaces it when it lands. NEVER read the raw `modes`.
 */
export interface FulfilmentCapabilityLike {
  counter: "always" | "optional" | "off";
  methods?: readonly string[];
  staffDefault?: string | null;
}

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
export function counterSaleGate(cap: FulfilmentCapabilityLike | null | undefined): CounterSaleGate {
  if (!cap) return NO_COUNTER;
  if (cap.counter === "optional")
    return { showButton: true, opensAsCounter: false, offerShipInstead: false };
  if (cap.counter === "always")
    return {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: (cap.methods ?? []).includes("SHIP"),
    };
  return NO_COUNTER;
}

/** SA rule: the CUSTOMER's own fulfilment path first, then `capabilities.fulfilment.staffDefault`. A SHIP-default customer stays SHIP. */
export function preselectFulfilment(
  customerPath: string | null | undefined,
  staffDefault: string | null | undefined,
): string | null {
  return customerPath ?? staffDefault ?? null;
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

export type PaymentProblem = "TENDER_SHORT" | "CHECK_NUMBER_REQUIRED" | "WALK_IN_NO_ACCOUNT";

export function validatePayment(input: {
  method: CounterSalePaymentMethod;
  total: number;
  tendered?: number;
  reference?: string;
  isWalkIn: boolean;
}): PaymentProblem | null {
  if (input.method === "ON_ACCOUNT" && input.isWalkIn) return "WALK_IN_NO_ACCOUNT";
  if (input.method === "CASH" && !(Number(input.tendered ?? 0) >= input.total))
    return "TENDER_SHORT";
  if (input.method === "CHECK" && !(input.reference ?? "").trim()) return "CHECK_NUMBER_REQUIRED";
  return null;
}

export const PAYMENT_PROBLEM_COPY: Record<PaymentProblem, string> = {
  TENDER_SHORT: "The amount tendered is less than the total.",
  CHECK_NUMBER_REQUIRED: "Enter the check number.",
  WALK_IN_NO_ACCOUNT:
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

/** FIXED copy by status (and the one named 403 code); the server's own message is never shown. */
export function counterSaleErrorCopy(err: unknown): string {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  const status = res?.status;
  if (status === 403 && res?.data?.code === API_ERROR_CODES.COUNTER_SALES_DISABLED)
    return COUNTER_SALES_DISABLED_COPY;
  if (status === 403) return "You don't have permission to complete a counter sale.";
  if (status === 409)
    return "Something changed while you were checking out. Review the sale and try again. Nothing was charged.";
  if (status === 400 || status === 422)
    return "This sale can't be completed as entered. Check the items and payment and try again.";
  return "The sale could not be completed. Nothing was charged. Try again.";
}

/** One key per SALE (sent as `Idempotency-Key`): a retry of the same sale reuses it, a new sale gets a new one. */
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
