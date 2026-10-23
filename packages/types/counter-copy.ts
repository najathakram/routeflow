/**
 * I-120 (SA-861 rules 1 and 10; owner naming ruling 2026-10-23): one word per idea, shared by web and mobile.
 * "Counter sale" is the till (ring up, pay, receipt in one step); "Store pickup" is what Create Order called "POS mode"
 * (a named customer, invoiced now, handed over at the store); "Complete at counter" finishes any open order at the store.
 * Copy only: the keys (`orders.posMode`, `USE_POS_MODE`, `FulfillPath.PICKUP`) stay. Pure, no imports (mobile subpath).
 */
export const COUNTER_COPY = {
  counterSale: "Counter sale",
  storePickup: "Store pickup",
  completeAtCounter: "Complete at counter",
  completeConfirm: "Complete",
  completed: "Completed at counter.",
  completedEmailed: "Completed at counter. The invoice was emailed to the customer.",
} as const;

/**
 * I-120 (#3689 review MUST 4): the fixed copy of a refused "Complete at counter" (and pickup hand-over), shared by web
 * and mobile, each with its own money formatter; null for a code this does not own. Every one of these refusals happens
 * before the first write (the credit gate is pre-judged, SA-905 MUST 1), so each says nothing changed. Codes are the
 * API_ERROR_CODES values (written out: this file has no imports, so mobile can resolve it by subpath).
 */
export function counterCompleteRefusalCopy(
  body: { code?: unknown; limit?: unknown; exposure?: unknown } | null | undefined,
  money: (n: number) => string,
): string | null {
  switch (body?.code) {
    case "COUNTER_COMPLETE_UNAVAILABLE":
      return "Nothing changed. This business doesn't hand orders over at the store.";
    case "CREDIT_LIMIT_EXCEEDED": {
      const figures =
        typeof body.limit === "number" && typeof body.exposure === "number"
          ? ` (${money(body.exposure)} of ${money(body.limit)})`
          : "";
      return `Nothing changed. This customer is over their credit limit${figures}. Take payment now, or record a payment first.`;
    }
    case "SELLING_RESTRICTED":
      return "Nothing changed. An item on this order can't be sold at the store. Edit the order, or deliver it.";
    case "ORDER_ON_ACTIVE_RUN":
      return "Nothing changed. This order is on an active delivery run. Remove it from the run first.";
    default:
      return null;
  }
}

/** The lines a complete-mode refusal shares with the pickup hand-over, in words that never say "pickup". */
export const COMPLETE_MODE_ERROR_COPY = {
  generic: "Couldn't complete the order. Check it and try again.",
  notReady: "This order can't be completed now: it's a draft, part-delivered, or cancelled.",
  keyConflict: "Already completed. Record any payment on the invoice.",
} as const;
