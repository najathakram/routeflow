import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { orderEditMode } from "./order-edit-restrictions";

/**
 * W-871 (SA-948 §2 MUST 1): a replace deletes every line of the order and re-creates it. Each
 * `InvoiceItem.orderItemId` is `onDelete: SetNull`, so on a post-delivery order the invoice's lines lose their
 * provenance, the in-place re-sync (R1) cannot restate them, and the invoice stays at its old total. So a replace
 * (staff replace-all, a driver's full-list save) on a post-delivery order is refused before any write. The mode is
 * the ONE edit-mode predicate the delivered-line lock reads; `postDeliveryEdit` is updateOrderItems' own routing
 * (`carrierGuard.resyncsInPlace`). Per-line edits keep R1.
 */
export const LINES_REPLACE_AFTER_DELIVERY_MESSAGE =
  "This order has been delivered. Change its lines one at a time.";

export function assertNoReplaceAfterDelivery(
  postDeliveryEdit: boolean,
  user: { role?: string } | undefined,
  dto: { replaceAll?: boolean },
  isDiffPayload: boolean,
): void {
  if (!postDeliveryEdit) return;
  if (orderEditMode(user?.role, dto.replaceAll, isDiffPayload).kind !== "replace") return;
  throw new ConflictException({
    code: API_ERROR_CODES.LINES_REPLACE_AFTER_DELIVERY,
    message: LINES_REPLACE_AFTER_DELIVERY_MESSAGE,
  });
}
