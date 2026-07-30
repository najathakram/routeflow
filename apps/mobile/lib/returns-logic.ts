/**
 * Pure returns helpers — status pill + which actions the current status allows.
 * The action flags mirror the server's transition guards exactly so the UI never
 * fires a doomed request (approve/reject only from PENDING; in-transit only from
 * APPROVED; receive from APPROVED or IN_TRANSIT; refund only from RECEIVED).
 */

export type ReturnPillVariant = "orange" | "brand" | "green" | "gray" | "red";

export function returnPillFor(status: string): { variant: ReturnPillVariant; label: string } {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "APPROVED":
      return { variant: "brand", label: "Approved" };
    case "IN_TRANSIT":
      return { variant: "brand", label: "In transit" };
    case "RECEIVED":
      return { variant: "brand", label: "Received" };
    case "REFUNDED":
      return { variant: "green", label: "Refunded" };
    case "PROCESSED":
      return { variant: "green", label: "Processed" };
    case "REJECTED":
      return { variant: "red", label: "Rejected" };
    case "CANCELLED":
      return { variant: "gray", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface ReturnActionFlags {
  canApprove: boolean;
  canReject: boolean;
  canMarkInTransit: boolean;
  canReceive: boolean;
  /**
   * "Resolve without receiving": receive with restocking suppressed, then resolve
   * straight away — same predicate as canReceive (APPROVED or IN_TRANSIT), offered
   * as a secondary action alongside the normal physical-receipt path.
   */
  canResolveWithoutReceipt: boolean;
  canRefund: boolean;
  /** No further action — a terminal status. */
  terminal: boolean;
}

export interface ReturnLineInput {
  productId: string | null;
  orderedQty: number;
}

/**
 * Build the create-return items payload from the operator's per-line qty inputs:
 * skip unlisted/zero/blank lines, and cap each return qty at the ordered qty.
 */
export function buildReturnItems(
  lines: ReturnLineInput[],
  qtyByProduct: Record<string, string>,
  restockByProduct: Record<string, boolean>,
): { productId: string; qty: number; restock: boolean }[] {
  const out: { productId: string; qty: number; restock: boolean }[] = [];
  for (const li of lines) {
    if (!li.productId) continue;
    const qty = Math.floor(Number(qtyByProduct[li.productId] ?? ""));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      productId: li.productId,
      qty: Math.min(qty, Math.max(0, Math.floor(li.orderedQty))),
      restock: restockByProduct[li.productId] ?? true,
    });
  }
  return out;
}

export function returnActionFlags(status: string): ReturnActionFlags {
  const canApprove = status === "PENDING";
  const canReject = status === "PENDING";
  const canMarkInTransit = status === "APPROVED";
  const canReceive = status === "APPROVED" || status === "IN_TRANSIT";
  const canResolveWithoutReceipt = canReceive;
  const canRefund = status === "RECEIVED";
  const terminal =
    status === "REFUNDED" ||
    status === "PROCESSED" ||
    status === "REJECTED" ||
    status === "CANCELLED";
  return {
    canApprove,
    canReject,
    canMarkInTransit,
    canReceive,
    canResolveWithoutReceipt,
    canRefund,
    terminal,
  };
}
