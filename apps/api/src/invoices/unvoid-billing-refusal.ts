import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-814d: the 409 ORDER_BILLING_CHANGED an unvoid answers with. `reason` is the machine-readable part (clients pick
 * copy from it, never by string match); `message` is the same copy for clients that show the server message.
 * Literal copies of `ORDER_BILLING_CHANGED_REASONS` / `UNVOID_BILLING_COPY` in `@routeflow/types` (the API never
 * value-imports that package), pinned equal by `unvoid-billing-refusal-parity.spec.ts`.
 */
export const UNVOID_REFUSAL_REASONS = {
  OTHER_INVOICE: "OTHER_INVOICE",
  LINE_REDUCED: "LINE_REDUCED",
} as const;

export type UnvoidRefusalReason =
  (typeof UNVOID_REFUSAL_REASONS)[keyof typeof UNVOID_REFUSAL_REASONS];

export const UNVOID_REFUSAL_COPY: Record<UnvoidRefusalReason, string> = {
  OTHER_INVOICE: "Another invoice now bills these items. Void it first.",
  LINE_REDUCED:
    "The order line now holds less than this invoice bills. Raise the order line, or create a new invoice from the order.",
};

/** B693 (SA-839): the 409 UNVOID_ORDER_CANCELLED copy — an invoice of a cancelled order is not restored. */
export const UNVOID_ORDER_CANCELLED_MESSAGE =
  "This invoice's order was cancelled, so the invoice can't be restored. Create a new invoice instead.";

/**
 * B693 (SA-839): read under the unvoid's Order lock, BEFORE the B299 re-claim, so a refusal writes
 * nothing. A restored invoice would bill again, and book a regulated sale again, for goods of an
 * order that was cancelled: 409 UNVOID_ORDER_CANCELLED.
 */
export async function assertUnvoidOrderNotCancelled(
  tx: any,
  orderId: string | null,
): Promise<void> {
  if (!orderId) return;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (order?.status === OrderStatus.CANCELLED)
    throw new ConflictException({
      code: API_ERROR_CODES.UNVOID_ORDER_CANCELLED,
      message: UNVOID_ORDER_CANCELLED_MESSAGE,
    });
}
