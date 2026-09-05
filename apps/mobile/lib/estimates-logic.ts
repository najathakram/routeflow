import { computeLineSubtotal } from "@routeflow/pricing";
import type { EstimateStatus } from "./api/estimates";

/**
 * Pure (screen-free, testable) estimate helpers — the status→pill mapping, the
 * action gating, and the money-safe line amount. Kept out of the RN screens so
 * `apps/mobile/__tests__/*.test.ts` (pure-logic, node env) can lock them.
 */

export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";

/** Status → badge variant + label. Mirrors the web estimates status chips. */
export function estimatePillFor(status: EstimateStatus): { variant: PillVariant; label: string } {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "brand", label: "Sent" };
    case "ACCEPTED":
      return { variant: "green", label: "Accepted" };
    case "DECLINED":
      return { variant: "red", label: "Declined" };
    case "EXPIRED":
      return { variant: "orange", label: "Expired" };
    case "CONVERTED":
      return { variant: "purple", label: "Converted" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface EstimateActionFlags {
  canSend: boolean;
  canAcceptDecline: boolean;
  canConvert: boolean;
  canVoid: boolean;
}

/**
 * Which detail-screen actions are available for a status. Deliberately stricter
 * than web on Convert: the API only converts ACCEPTED estimates
 * (`BadRequestException("Only ACCEPTED estimates can be converted")`), so we
 * gate Convert to ACCEPTED to avoid guaranteed error toasts. Void is rejected by
 * the server on CONVERTED, and DECLINED/EXPIRED are terminal read-only.
 */
export function estimateActionFlags(status: EstimateStatus): EstimateActionFlags {
  return {
    canSend: status === "DRAFT",
    canAcceptDecline: status === "SENT",
    canConvert: status === "ACCEPTED",
    canVoid: status !== "CONVERTED" && status !== "DECLINED" && status !== "EXPIRED",
  };
}

export interface LineAmountInput {
  subtotal?: number;
  unitPrice: number;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number;
}

/**
 * Authoritative line amount. Prefer the server-computed `subtotal`; only when
 * absent, delegate to `computeLineSubtotal` (boxed proration aware) — NEVER
 * `qty * unitPrice`, which over-charges a boxed line by `unitsPerBox`.
 */
export function estimateLineAmount(item: LineAmountInput): number {
  if (item.subtotal != null) return Number(item.subtotal);
  return computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty: item.qty,
    boxes: item.boxes,
    pieces: item.pieces,
    unitsPerBox: item.unitsPerBox,
  });
}
