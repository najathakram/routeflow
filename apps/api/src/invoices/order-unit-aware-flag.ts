/**
 * B797: extends the units_v1 edit guard (B641) to the linked order's lines too —
 * recomputeOrderFromInvoices back-syncs an edit onto the linked order's unit-aware
 * line even when the invoice's own items carry no unitLabel (same reason
 * assertInvoiceRewriteAllowed in unit-aware-guard.ts checks both). Split out of
 * invoices.service.ts per SA-113 (the next PR touching that file extracts first).
 */

/** Prisma select fragment for findOne's `order` relation — existence-only, spread
 *  alongside `status`/`orderNumber`. Never expose the fetched lineItems raw. */
export const ORDER_UNIT_AWARE_LINE_SELECT = {
  lineItems: {
    where: { unitLabel: { not: null }, status: { not: "CANCELLED" } },
    select: { id: true },
    take: 1,
  },
} as const;

interface OrderWithUnitAwareSelect {
  status: string;
  orderNumber: string | null;
  lineItems?: { id: string }[];
}

/** The stripped `order` summary (never the raw lineItems) plus the existence-only flag —
 *  spread directly into findOne's return object, one line at the call site. */
export function orderSummaryWithUnitFlag(order: OrderWithUnitAwareSelect | null | undefined): {
  order: { status: string; orderNumber: string | null } | null;
  orderHasUnitAwareLine: boolean;
} {
  return {
    order: order ? { status: order.status, orderNumber: order.orderNumber } : null,
    orderHasUnitAwareLine: (order?.lineItems?.length ?? 0) > 0,
  };
}
