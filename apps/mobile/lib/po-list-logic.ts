import type { POStatus } from "./api/purchase-orders";

/**
 * Pure logic for the operator purchase-order list (`app/(operator)/purchase-orders/index.tsx`),
 * kept out of the screen so it can be unit-tested (mobile Jest is pure-logic only).
 */

export type PoPillVariant = "brand" | "green" | "orange" | "red" | "gray";

export function poStatusPill(status: POStatus): { variant: PoPillVariant; label: string } {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "orange", label: "Sent" };
    case "PARTIAL":
      return { variant: "brand", label: "Partial" };
    case "RECEIVED":
      return { variant: "green", label: "Received" };
    case "CLOSED":
      return { variant: "gray", label: "Closed" };
    default:
      return { variant: "gray", label: status };
  }
}

export const PO_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "OPEN", label: "Open" },
  { id: "RECEIVED", label: "Received" },
] as const;

export type PoFilterId = (typeof PO_FILTERS)[number]["id"];

/** The `status` param for the "all POs" query — only the Received chip narrows it. The Open chip
 *  uses its own multi-status query (`useOpenPurchaseOrders`). */
export function poListStatusParam(filter: PoFilterId): POStatus | undefined {
  return filter === "RECEIVED" ? "RECEIVED" : undefined;
}

export function poFilterFromLabel(label: string): PoFilterId {
  return PO_FILTERS.find((f) => f.label === label)?.id ?? "ALL";
}

/**
 * The total to show on a PO row or detail header: #2637 (the lead's condition) moved the ONE rule to
 * @routeflow/pricing (`poDisplayTotal`), shared with web. It prefers the server-stored `totalAmount`
 * (a numeric STRING, coerced and now rounded to cents like web's), else the rounded sum of the lines'
 * STORED totals (B698).
 */
export { poDisplayTotal } from "@routeflow/pricing";

export function formatPoMoney(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}
