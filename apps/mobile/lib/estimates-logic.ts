import { computeLineSubtotal } from "@routeflow/pricing";
import { canMoveEstimate } from "@routeflow/types/api/estimate-moves";
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
    case "CONVERTED":
      return { variant: "purple", label: "Converted" };
    case "VOID":
      return { variant: "gray", label: "Void" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface EstimateActionFlags {
  canSend: boolean;
  canAcceptDecline: boolean;
  canConvert: boolean;
  canVoid: boolean;
  /** SENT or ACCEPTED goes back to draft to be revised (web has the same button). */
  canRevert: boolean;
}

/**
 * Which detail-screen actions are available for a status. Convert, Void and Back to draft read
 * `ESTIMATE_MOVES` (SA-1263), the table the API claims with, so a status the API refuses is never
 * offered: CONVERTED, DECLINED and VOID show no actions. Send and Accept/Decline are each offered on
 * one status only (a UI choice; the API allows more). (Wave E /
 * imp-10b, L-072: this used to also exclude a phantom "EXPIRED" status the
 * schema has never had — dropped along with the dead pill-mapping branch above.)
 */
export function estimateActionFlags(status: EstimateStatus): EstimateActionFlags {
  return {
    canSend: status === "DRAFT",
    canAcceptDecline: status === "SENT",
    canConvert: canMoveEstimate(status, "convert"),
    canVoid: canMoveEstimate(status, "void"),
    canRevert: canMoveEstimate(status, "revert"),
  };
}

export interface LineAmountInput {
  subtotal?: number;
  unitPrice: number;
  qty: number;
  boxes?: number;
  pieces?: number;
  /** Null on an unboxed line (the shared EstimateItem shape). */
  unitsPerBox?: number | null;
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
