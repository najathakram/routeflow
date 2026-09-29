/**
 * P5-10/P5-11: shared web model for post-dispatch change requests (the P5-09
 * engine). Mirrors the API's ChangeRequest row + payload shapes
 * (apps/api/src/orders/change-requests.service.ts). Pure types + formatting
 * helpers — deliberately NO HTTP-client imports so both the operator surface
 * (lib/api/orders.ts) and the buyer surface (lib/api/buyer.ts) can use it.
 */

// #2703 (SA-562): the row + its enums are ONE declaration in @routeflow/types.
import type { ChangeRequest } from "@routeflow/types";
export type {
  ChangeRequest,
  ChangeRequestResolution,
  ChangeRequestStatus,
  ChangeRequestType,
} from "@routeflow/types";
export type ChangeRequestResolveAction = "APPROVE_AT_STOP" | "APPROVE_NEXT_DELIVERY" | "DECLINE";

/** Minimal line shape needed to label CHANGE_QTY/REMOVE_ITEM requests. */
interface LineForLabel {
  id: string;
  name?: string | null;
  product?: { name: string } | null;
}

/**
 * Human summary of a change request. Shows NO money on purpose: the price of
 * an added/changed line is decided by the server's pricing path at approval —
 * previewing a price here would be a second derivation that can drift.
 */
export function describeChangeRequest(
  cr: ChangeRequest,
  lineItems: LineForLabel[] | undefined,
): { title: string; detail: string | null } {
  const lineLabel = (orderItemId: string | null | undefined): string => {
    const li = (lineItems ?? []).find((l) => l.id === (orderItemId ?? ""));
    return li?.product?.name ?? li?.name ?? "an item";
  };
  switch (cr.type) {
    case "ADD_ITEM": {
      const boxes = cr.payload.boxes;
      const split =
        boxes != null
          ? ` (${boxes} box${Number(boxes) === 1 ? "" : "es"}${
              cr.payload.pieces ? ` + ${cr.payload.pieces} pcs` : ""
            })`
          : "";
      return {
        title: `Add ${Number(cr.payload.qty ?? 0)} × ${cr.payload.productName ?? "item"}${split}`,
        detail: cr.note,
      };
    }
    case "CHANGE_QTY":
      return {
        title: `Change ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)} to qty ${Number(
          cr.payload.newQty ?? 0,
        )}`,
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

/** Outcome line shown once a CR is resolved (null while PENDING). */
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
