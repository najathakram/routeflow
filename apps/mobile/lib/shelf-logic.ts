/**
 * P5-16b: Your Shelf + change-request pure logic — Jest-tested, no RN imports.
 * Mirrors the web shelf page + apps/web/lib/change-requests.ts.
 * MONEY: buildShelfAddItem is the ONE money-sensitive spot — a boxed product's
 * Add payload MUST carry {boxes, pieces:0} (a bare qty is read as a BOX count →
 * unitsPerBox× over-order/over-charge). Locked by the test.
 */
import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { BuyerOrder, ChangeRequest, ChangeRequestStatus, ShelfEstimate } from "./api/buyer";

export interface ShelfSections {
  low: ShelfEstimate[];
  dueSoon: ShelfEstimate[];
  snoozed: ShelfEstimate[];
  rest: ShelfEstimate[];
}

export function groupShelfEstimates(estimates: ShelfEstimate[] | undefined): ShelfSections {
  const list = estimates ?? [];
  return {
    low: list.filter((e) => e.state === "low" && !e.snoozed),
    dueSoon: list.filter((e) => e.state === "due-soon" && !e.snoozed),
    snoozed: list.filter((e) => e.snoozed),
    rest: list.filter((e) => e.state === "ok" && !e.snoozed),
  };
}

export interface ShelfAddItem {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
}

export function buildShelfAddItem(
  e: Pick<ShelfEstimate, "productId" | "suggestedQty" | "unitsPerBox">,
): ShelfAddItem {
  const upb = Math.trunc(Number(e.unitsPerBox ?? 0));
  if (upb > 1) {
    const boxes = Math.max(1, Math.round(Number(e.suggestedQty) / upb));
    const norm = normalizeBoxesPieces({ boxes, pieces: 0, unitsPerBox: upb });
    return {
      productId: e.productId,
      qty: norm.qty,
      boxes: norm.boxes ?? boxes,
      pieces: norm.pieces ?? 0,
    };
  }
  return { productId: e.productId, qty: Math.max(1, Math.trunc(Number(e.suggestedQty) || 0)) };
}

export function qtyLabel(e: Pick<ShelfEstimate, "suggestedQty" | "unitsPerBox" | "unit">): string {
  if (e.unitsPerBox && e.unitsPerBox > 1) {
    const boxes = Math.max(1, Math.round(e.suggestedQty / e.unitsPerBox));
    return `${e.suggestedQty} pcs (${boxes} ${boxes === 1 ? "box" : "boxes"} of ${e.unitsPerBox})`;
  }
  return `${e.suggestedQty} ${e.unit}`;
}

export function daysLeftFraction(
  e: Pick<ShelfEstimate, "estDaysLeft" | "cadenceDays">,
): number | null {
  if (e.estDaysLeft == null || e.cadenceDays == null || e.cadenceDays <= 0) return null;
  return Math.min(1, Math.max(0, e.estDaysLeft / e.cadenceDays));
}

export function daysLeftLabel(e: Pick<ShelfEstimate, "estDaysLeft">): string {
  if (e.estDaysLeft == null) return "no pattern yet";
  if (e.estDaysLeft < 0) return `${Math.abs(e.estDaysLeft)}d overdue`;
  if (e.estDaysLeft === 0) return "due today";
  return `~${e.estDaysLeft}d left`;
}

export function orderEditable(o: Pick<BuyerOrder, "status" | "editWindow">): boolean {
  return (o.status === "PENDING" || o.status === "CONFIRMED") && (o.editWindow?.editable ?? true);
}

export function orderCancellable(o: Pick<BuyerOrder, "status" | "editWindow">): boolean {
  return (o.status === "PENDING" || o.status === "DRAFT") && (o.editWindow?.editable ?? true);
}

export function canRequestChange(o: Pick<BuyerOrder, "status" | "routeRun">): boolean {
  return (
    o.routeRun?.status === "IN_PROGRESS" &&
    ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(o.status)
  );
}

export interface ChangeRequestChipSpec {
  label: string;
  variant: "orange" | "green" | "red" | "gray";
}

export function changeRequestChip(status: ChangeRequestStatus): ChangeRequestChipSpec {
  switch (status) {
    case "PENDING":
      return { label: "Pending", variant: "orange" };
    case "APPROVED":
      return { label: "Approved", variant: "green" };
    case "DECLINED":
      return { label: "Declined", variant: "red" };
    default:
      return { label: String(status), variant: "gray" };
  }
}

interface LineForLabel {
  id: string;
  product?: { name: string } | null;
}

/** Human summary — shows NO money on purpose (price is decided server-side at approval). */
export function describeChangeRequest(
  cr: ChangeRequest,
  lineItems: LineForLabel[] | undefined,
): { title: string; detail: string | null } {
  const lineLabel = (orderItemId: string | null | undefined): string => {
    const li = (lineItems ?? []).find((l) => l.id === (orderItemId ?? ""));
    return li?.product?.name ?? "an item";
  };
  switch (cr.type) {
    case "ADD_ITEM": {
      const boxes = cr.payload.boxes;
      const split =
        boxes != null
          ? ` (${boxes} box${Number(boxes) === 1 ? "" : "es"}${cr.payload.pieces ? ` + ${cr.payload.pieces} pcs` : ""})`
          : "";
      return {
        title: `Add ${Number(cr.payload.qty ?? 0)} × ${cr.payload.productName ?? "item"}${split}`,
        detail: cr.note,
      };
    }
    case "CHANGE_QTY":
      return {
        title: `Change ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)} to qty ${Number(cr.payload.newQty ?? 0)}`,
        detail: cr.note,
      };
    case "REMOVE_ITEM":
      return {
        title: `Remove ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)}`,
        detail: cr.note,
      };
    case "NOTE":
      return { title: "Note for the driver", detail: cr.payload.text ?? cr.note };
    default:
      return { title: "Change request", detail: cr.note };
  }
}

export function describeResolution(cr: ChangeRequest): string | null {
  if (cr.status === "APPROVED") {
    return cr.resolution === "NEXT_DELIVERY"
      ? "Approved — added to the next delivery"
      : "Approved — applied to today's delivery";
  }
  if (cr.status === "DECLINED") {
    return cr.resolutionReason ? `Declined — ${cr.resolutionReason}` : "Declined";
  }
  return null;
}
