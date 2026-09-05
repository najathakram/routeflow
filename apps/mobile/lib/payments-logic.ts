import type { Ionicons } from "@expo/vector-icons";
import type { PaymentMethod } from "./api/invoices";
import type { PaymentStatus } from "./api/payments";
import { roundMoney } from "@routeflow/pricing";

/**
 * Pure payments helpers — method/status → pill + icon, and void gating. Kept out
 * of the RN screens so __tests__/*.test.ts (node env) can lock them.
 *
 * Money: a payment is a single scalar `amount` (+ optional `bankCharges`). There
 * is NO qty*unitPrice risk — render server values via fmtCurrency; never derive.
 */
export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";
type IoniconName = keyof typeof Ionicons.glyphMap;

/** Method → badge variant + label + icon. Mirrors the web method labels/colors. */
export function paymentMethodPill(method: PaymentMethod): {
  variant: PillVariant;
  label: string;
  icon: IoniconName;
} {
  switch (method) {
    case "CASH":
      return { variant: "green", label: "Cash", icon: "cash-outline" };
    case "CHECK":
      return { variant: "brand", label: "Check", icon: "document-text-outline" };
    case "ZELLE":
      return { variant: "purple", label: "Zelle", icon: "flash-outline" };
    case "ACH":
      return { variant: "purple", label: "ACH", icon: "swap-horizontal-outline" };
    case "CREDIT_CARD":
      return { variant: "orange", label: "Card", icon: "card-outline" };
    case "CREDIT_NOTE":
      return { variant: "purple", label: "Credit Note", icon: "receipt-outline" };
    case "ADVANCE":
      return { variant: "brand", label: "Advance", icon: "wallet-outline" };
    case "OTHER":
    default:
      return { variant: "gray", label: "Other", icon: "ellipsis-horizontal-circle-outline" };
  }
}

/** Status → pill. Undefined defaults to Paid (server default; legacy rows). */
export function paymentStatusPill(status?: PaymentStatus): { variant: PillVariant; label: string } {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "VOID":
      return { variant: "red", label: "Void" };
    case "PAID":
    default:
      return { variant: "green", label: "Paid" };
  }
}

export interface PaymentActionFlags {
  canVoid: boolean;
}

/**
 * Void is allowed for anything not already VOID (the server 400s a re-void).
 * CREDIT_NOTE payments are also excluded — voiding one would need to unwind
 * the credit-note application (a separate primitive), so the API refuses it;
 * the button is hidden here to match. ADVANCE stays voidable — voiding
 * restores the source AdvancePayment.balance (see invoices.service voidPayment).
 */
export function paymentActionFlags(
  status?: PaymentStatus,
  method?: PaymentMethod,
): PaymentActionFlags {
  return { canVoid: status !== "VOID" && method !== "CREDIT_NOTE" };
}

// ─── Check lifecycle (P5-12; Wave 3 operator controls) ───────────────────────

export type CheckStatus = "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED";

/** Mirror of the server's transition table (invoices.service.ts CHECK_TRANSITIONS)
 *  so no offered action can 400. BOUNCED is terminal. */
export const CHECK_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  RECORDED: ["DEPOSITED", "BOUNCED"],
  DEPOSITED: ["CLEARED", "BOUNCED"],
  CLEARED: ["BOUNCED"],
  BOUNCED: [],
};

/**
 * Legal next check states for a payment row: only CHECK payments that aren't
 * voided; a null stored checkStatus means RECORDED (server default — rows
 * recorded before P5-12, and every standalone/at-door check row).
 */
export function checkNextStates(p: {
  method?: string;
  status?: string;
  checkStatus?: string | null;
}): CheckStatus[] {
  if (p.method !== "CHECK" || p.status === "VOID") return [];
  const current = (p.checkStatus ?? "RECORDED") as CheckStatus;
  return [...(CHECK_TRANSITIONS[current] ?? [])];
}

// ─── Standalone payment allocation (Wave 3) ──────────────────────────────────

export interface AllocationRow {
  invoiceId: string;
  amount: number;
}

/**
 * Oldest invoices first for the allocation waterfall: earliest issueDate (falls
 * back to createdAt) wins. The server applies allocations in ARRAY ORDER and
 * does no selection of its own, so the client owns "oldest-first".
 */
export function oldestInvoicesFirst<
  T extends { issueDate?: string | null; createdAt?: string | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.issueDate ?? a.createdAt ?? "").localeCompare(b.issueDate ?? b.createdAt ?? ""),
  );
}

/**
 * Greedy waterfall pre-fill for `POST /invoices/payments/record`. The server
 * applies the allocations VERBATIM — no rounding, no per-invoice cap, no
 * sum≤total check (invoices.service.ts standalone path) — so every safety
 * property lives HERE: cents-rounded amounts, capped at each invoice's
 * balanceDue, and the running total never exceeds totalAmount. `excess`
 * (received − allocated) becomes an ADVANCE server-side when > 0.001.
 */
export function waterfallAllocations(
  totalAmount: number,
  invoices: Array<{ id: string; balanceDue: number }>,
): { allocations: AllocationRow[]; allocated: number; excess: number } {
  let remaining = roundMoney(Math.max(0, totalAmount));
  const allocations: AllocationRow[] = [];
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const due = roundMoney(Math.max(0, inv.balanceDue));
    if (due <= 0) continue;
    const apply = roundMoney(Math.min(remaining, due));
    if (apply <= 0) continue;
    allocations.push({ invoiceId: inv.id, amount: apply });
    remaining = roundMoney(remaining - apply);
  }
  const allocated = roundMoney(allocations.reduce((s, a) => s + a.amount, 0));
  return {
    allocations,
    allocated,
    excess: roundMoney(Math.max(0, roundMoney(totalAmount) - allocated)),
  };
}

/**
 * Totals for HAND-EDITED allocation rows (null = blank input). `overAllocated`
 * means the operator typed more than they received — the server would silently
 * accept it and record no advance, so the screen must block submit on it.
 */
export function allocationTotals(
  totalAmount: number,
  rows: Array<{ amount: number | null }>,
): { allocated: number; excess: number; overAllocated: boolean } {
  const allocated = roundMoney(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
  const total = roundMoney(totalAmount);
  return {
    allocated,
    excess: roundMoney(Math.max(0, total - allocated)),
    overAllocated: allocated > total + 0.001,
  };
}
