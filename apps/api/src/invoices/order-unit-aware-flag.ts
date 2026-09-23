/**
 * B797: extends the units_v1 edit guard (B641) to the linked order's lines too —
 * recomputeOrderFromInvoices back-syncs an edit onto the linked order's unit-aware
 * line even when the invoice's own items carry no unitLabel (same reason
 * assertInvoiceRewriteAllowed in unit-aware-guard.ts checks both). Split out of
 * invoices.service.ts per SA-113 (the next PR touching that file extracts first).
 */
import { isUnitAwareLine } from "../orders/unit-aware-guard";

/** Prisma select fragment for findOne's `order` relation — fetches every line's
 *  unitLabel/status (not a pre-filtered subset) so the flag below can compute it
 *  via unit-aware-guard.ts's own isUnitAwareLine, never a re-derived `where` (a
 *  Prisma `unitLabel: { not: null }` drifted from that definition on blank labels
 *  — review round 1: an "" label counted as unit-aware here but not to the guard,
 *  over-blocking an edit the server would actually allow). */
export const ORDER_UNIT_AWARE_LINE_SELECT = {
  lineItems: { select: { unitLabel: true, status: true } },
} as const;

interface OrderWithUnitAwareSelect {
  status: string;
  orderNumber: string | null;
  lineItems?: { unitLabel: string | null; status: string }[];
}

/** The stripped `order` summary (never the raw lineItems) plus the existence-only flag —
 *  spread directly into findOne's return object, one line at the call site. `orderId` is
 *  the invoice's own FK: set but `order` unreadable (cross-tenant/vanished) fails CLOSED,
 *  same reason assertInvoiceRewriteAllowed does — a parent we can't read proves nothing. */
export function orderSummaryWithUnitFlag(
  orderId: string | null | undefined,
  order: OrderWithUnitAwareSelect | null | undefined,
): {
  order: { status: string; orderNumber: string | null } | null;
  orderHasUnitAwareLine: boolean;
} {
  if (orderId && !order) {
    return { order: null, orderHasUnitAwareLine: true };
  }
  return {
    order: order ? { status: order.status, orderNumber: order.orderNumber } : null,
    orderHasUnitAwareLine: (order?.lineItems ?? []).some(isUnitAwareLine),
  };
}
