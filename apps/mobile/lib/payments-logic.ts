import type { Ionicons } from "@expo/vector-icons";
import type { PaymentMethod } from "./api/invoices";
import type { PaymentStatus } from "./api/payments";

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
