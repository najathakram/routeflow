import { OrderStatus } from "@prisma/client";

/**
 * SA-1101 §2.4: the two order-status lists every "done order" check reads, by name, instead of spelling
 * `DELIVERED` and `CANCELLED` out again (the way REFUSED would have been missed by every one of them).
 *
 * Literals on purpose, like `api-error-codes.ts`: API source never imports `@routeflow/types` at runtime
 * (its dist would load that package's TypeScript source through node). `terminal-order-status-lists.spec.ts`
 * pins both lists set-equal to `TERMINAL_ORDER_STATUSES` / `POST_DELIVERY_ORDER_STATUSES` in
 * `packages/types/api/enums.ts`, which web and mobile import.
 */

/** The order is done: not routable, not open, not cancellable, not releasable. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.REFUSED,
  OrderStatus.CANCELLED,
];

/** UX guide B12: in progress (accepted, not done). Pinned set-equal to the shared `ACTIVE_ORDER_STATUSES`. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
];

/** UX guide B12: the status groups a list may ask for (literal copy of the shared `ORDER_STATUS_GROUP_VALUES`). */
export const ORDER_STATUS_GROUP_VALUES = ["ACTIVE"] as const;

/** The delivery visit happened, so billing is on the delivered basis (final draft, no pending mirror). */
export const POST_DELIVERY_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.REFUSED,
];

export const isTerminalOrderStatus = (status: string | null | undefined): boolean =>
  TERMINAL_ORDER_STATUSES.includes(status as OrderStatus);

export const isPostDeliveryOrderStatus = (status: string | null | undefined): boolean =>
  POST_DELIVERY_ORDER_STATUSES.includes(status as OrderStatus);
