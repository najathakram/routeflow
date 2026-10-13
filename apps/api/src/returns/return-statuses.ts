import { ReturnStatus } from "@prisma/client";

/**
 * Returns that moved no money and never will (REJECTED / CANCELLED). A LEAF module on purpose: both today's sales
 * (orders/counter-sale/counter-sale-today.ts) and the refund guards (inline-return-refund.ts builds
 * `CASH_REFUNDED_RETURN_WHERE` from it at module top level) need it, and a shared module that imports either of them
 * recreates the load-order cycle that silently dropped the `notIn` filter.
 */
export const DEAD_RETURN_STATUSES = [ReturnStatus.REJECTED, ReturnStatus.CANCELLED];
