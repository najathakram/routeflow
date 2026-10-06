import type { BatchShipOutcome } from "@routeflow/types";

/**
 * Operator-facing copy for each batch-ship outcome (#3168). Pure (no React Native import) so it is
 * unit-tested. `Record<BatchShipOutcome, ...>` makes a new shared outcome a type error until it has
 * wording. Mirrors web's `lib/batch-ship-copy.ts`. `shipped` = marked shipped (a slip applies).
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
  CONCURRENT_UPDATE: {
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

/** The ids that actually shipped in a batch result: the only ones a packing slip is printed for. */
export function shippedOrderIds(
  results: { orderId: string; outcome: BatchShipOutcome }[],
): string[] {
  return results.filter((r) => BATCH_SHIP_COPY[r.outcome].shipped).map((r) => r.orderId);
}

/** Request body rows: carrier + tracking only for a row the operator typed a tracking number into. */
export function buildBatchShipRows(
  orderIds: string[],
  carriers: Record<string, string>,
  tracking: Record<string, string>,
  defaultCarrier: string,
): { orderId: string; carrier?: string; trackingNumber?: string }[] {
  return orderIds.map((orderId) => {
    const t = (tracking[orderId] ?? "").trim();
    return t
      ? { orderId, carrier: carriers[orderId] ?? defaultCarrier, trackingNumber: t }
      : { orderId };
  });
}
