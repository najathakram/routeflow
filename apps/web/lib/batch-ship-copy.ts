import type { BatchShipOutcome } from "@routeflow/types";

/**
 * Operator-facing copy for each batch-ship outcome (#3168). `Record<BatchShipOutcome, ...>` makes a new
 * outcome a type error until it has wording. `shipped` = the goods are marked shipped (slips apply).
 * Mobile keeps its own typed copy of this table (apps/mobile/lib/batch-ship-copy.ts).
 */
export const BATCH_SHIP_COPY: Record<
  BatchShipOutcome,
  { label: string; detail: string; tone: "ok" | "warn" | "error"; shipped: boolean }
> = {
  SHIPPED: { label: "Shipped", detail: "Marked shipped.", tone: "ok", shipped: true },
  SHIPPED_INVOICE_PENDING: {
    label: "Shipped, invoice needs attention",
    detail: "Marked shipped, but its invoice could not be created. Open the order to generate it.",
    tone: "warn",
    shipped: true,
  },
  NOT_CARRIER_ORDER: {
    label: "Not a carrier order",
    detail: "Only carrier orders can be marked shipped here.",
    tone: "error",
    shipped: false,
  },
  ALREADY_SHIPPED: {
    label: "Already shipped",
    detail: "Nothing was changed.",
    tone: "warn",
    shipped: false,
  },
  NOT_CONFIRMED: {
    label: "Not confirmed",
    detail: "Only confirmed orders can be marked shipped.",
    tone: "error",
    shipped: false,
  },
  CREDIT_HOLD: {
    label: "On credit hold",
    detail: "Resolve the customer's credit limit, then ship it again.",
    tone: "error",
    shipped: false,
  },
  ORDER_CHANGED: {
    label: "Changed meanwhile",
    detail: "The order changed while shipping. Review it and try again.",
    tone: "error",
    shipped: false,
  },
  INVALID_TRACKING: {
    label: "Invalid tracking",
    detail: "Check the carrier and tracking number. Nothing was changed.",
    tone: "error",
    shipped: false,
  },
  NOT_FOUND: {
    label: "Not found",
    detail: "This order could not be found.",
    tone: "error",
    shipped: false,
  },
  FAILED: {
    label: "Failed",
    detail: "Could not be marked shipped. Open the order to check it.",
    tone: "error",
    shipped: false,
  },
};

/**
 * The per-order result wording. When the tracking was written but the order did not ship, the row says
 * the tracking was saved (never "Nothing was changed", which would be false).
 */
export function batchShipDetail(r: { outcome: BatchShipOutcome; trackingSaved?: boolean }): string {
  const copy = BATCH_SHIP_COPY[r.outcome];
  if (!r.trackingSaved || copy.shipped) return copy.detail;
  return `${copy.detail.replace(/ ?Nothing was changed\./, "").trim()} Tracking was saved.`;
}

/** The ids that actually shipped in a batch result: the only ones a packing slip is printed for. */
export function shippedOrderIds(
  results: { orderId: string; outcome: BatchShipOutcome }[],
): string[] {
  return results.filter((r) => BATCH_SHIP_COPY[r.outcome].shipped).map((r) => r.orderId);
}
