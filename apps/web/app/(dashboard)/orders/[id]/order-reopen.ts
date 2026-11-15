import type { ApiOrderStatus } from "./_components/order-line-edit";

/**
 * SA-1136 R-5: the Reopen confirm tells both outcomes before the tap. The server decides which one happens (a cancelled
 * draft comes back as a draft, so it is checked again before it becomes an order; any other order comes back as Pending).
 * Mobile mirrors this sentence in `apps/mobile/lib/order-actions.ts`.
 */
export const REOPEN_CONFIRM_TEXT =
  "Reopen this order? A cancelled draft comes back as a draft. Any other order comes back as Pending.";

/** The status the page shows after a reopen: the server's answer, never a constant. */
export function statusAfterReopen(reopened: { status: ApiOrderStatus }): ApiOrderStatus {
  return reopened.status;
}
