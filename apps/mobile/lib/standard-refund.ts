/**
 * SA-740r2 item 4 (mobile mirrors web): the optional TENDER of a STANDARD return's recorded refund (EXTERNAL_REFUND), stored by the
 * server in `Return.refundTender` (CARD is CREDIT_CARD there). Optional until the mobile build that sends it is the minimum: a
 * refund with no tender stores null and the day's `tenderKnown` stays false. Store credit has no tender (the server 400s one).
 * Pure so the request shape and the choice are pinned without a navigator.
 */
import type { InlineRefundTender } from "@routeflow/types";
import type { RefundMethod, RefundReturnDto } from "./api/returns";

export const STANDARD_REFUND_TENDERS: ReadonlyArray<{ value: InlineRefundTender; label: string }> =
  [
    { value: "CASH", label: "Cash" },
    { value: "CARD", label: "Card" },
    { value: "CHECK", label: "Check" },
  ];

/** The POST /returns/:id/refund body: a tender rides only with a recorded refund, and only when one was chosen. */
export function resolveReturnRequest(
  id: string,
  method: RefundMethod,
  tender?: InlineRefundTender,
): RefundReturnDto {
  return { id, method, ...(method === "EXTERNAL_REFUND" && tender ? { tender } : {}) };
}

export interface ChoiceAction {
  label: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}

/** The "Refund by" action sheet: Cash / Card / Check, "Not recorded" (no tender), Cancel. */
export function refundTenderChoiceActions(
  pick: (tender: InlineRefundTender | undefined) => void,
): ChoiceAction[] {
  return [
    ...STANDARD_REFUND_TENDERS.map((t) => ({
      label: t.label,
      style: "default" as const,
      onPress: () => pick(t.value),
    })),
    { label: "Not recorded", style: "default" as const, onPress: () => pick(undefined) },
    { label: "Cancel", style: "cancel" as const },
  ];
}

/**
 * SA-773: a STANDARD return whose goods were already returned or credited (`refundEstimateReason` EXCEEDS_REFUNDABLE) is
 * refused by the refund claim, so the screen blocks Resolve and says what is left instead of offering the priced amount.
 * Null when the return can be resolved.
 */
export function refundBlockedText(ret: {
  refundEstimate?: number | null;
  refundEstimateReason?: string | null;
}): string | null {
  if (ret.refundEstimateReason !== "EXCEEDS_REFUNDABLE") return null;
  const left =
    ret.refundEstimate && ret.refundEstimate > 0
      ? `Up to $${ret.refundEstimate.toFixed(2)} can still be given back for these goods.`
      : "Nothing more can be given back for these goods.";
  return `These goods were already returned or credited, so this return can't be resolved as it stands. ${left} Cancel the return and give an inline return or a credit note for what is left.`;
}
