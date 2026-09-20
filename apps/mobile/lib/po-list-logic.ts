import { roundMoney } from "@routeflow/pricing";
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

interface PoTotalInput {
  /** `PurchaseOrder.totalAmount` is a Prisma `Decimal(10,2)` — it arrives as a numeric STRING. */
  totalAmount?: number | string | null;
  items: { qtyOrdered: number | string; unitCost: number | string }[];
}

/**
 * The total to show on a PO row. Prefers the server-stored total (the agreed money); when it is
 * missing or not positive, falls back to the rounded sum of the lines — the detail screen's
 * `Number(po.totalAmount) || computedTotal` rule, except that a negative stored total also falls
 * back here (unreachable today: costs are validated >= 0). The stored total is coerced with `Number()`:
 * the list used to guard with `Number.isFinite(<string>)`, which is false for "123.45", so every
 * PO with a server total rendered $0.00.
 */
export function poDisplayTotal(po: PoTotalInput): number {
  const stored = Number(po.totalAmount);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const computed = roundMoney(
    po.items.reduce((sum, i) => sum + Number(i.qtyOrdered) * Number(i.unitCost), 0),
  );
  return Number.isFinite(computed) ? computed : 0;
}

export function formatPoMoney(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}
