import { uuidv5 } from "../../common/uuidv5";

/**
 * The fixed UUID namespace of a POS-mode hand-over's tender group (generated once; pinned by
 * pickup-tender-group.spec.ts). Never regenerate it: stored `paymentGroupId`s are derived from it.
 */
export const PICKUP_TENDER_NS = "c88751da-b90f-4a39-9f0d-ff319309fe01";

/**
 * The `paymentGroupId` of the tender a pickup-complete hand-over takes for `orderId`: a v5 id, so the
 * writer (pickup-complete) and the reader (Today's sales "Hand-overs") derive it from the order alone.
 * The leg index is 0: a hand-over takes one tender.
 */
export function pickupTenderGroupId(orderId: string): string {
  return uuidv5(`${orderId}:pickup:0`, PICKUP_TENDER_NS);
}
