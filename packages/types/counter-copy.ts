/**
 * I-120 (SA-861 rules 1 and 10; owner naming ruling 2026-10-23): one word per idea, shared by web and mobile.
 * "Counter sale" is the till (ring up, pay, receipt in one step); "Store pickup" is what Create Order called "POS mode"
 * (a named customer, invoiced now, handed over at the store); "Complete at counter" finishes any open order at the store.
 * Copy only: the keys (`orders.posMode`, `USE_POS_MODE`, `FulfillPath.PICKUP`) stay. Pure (mobile resolves it by subpath).
 */
import { API_ERROR_CODES } from "./api/error-codes";

export const COUNTER_COPY = {
  counterSale: "Counter sale",
  storePickup: "Store pickup",
  completeAtCounter: "Complete at counter",
  completeConfirm: "Complete",
  completed: "Completed at counter.",
  completedEmailed: "Completed at counter. The invoice was emailed to the customer.",
  /** SA-913 R8: the run confirm's action; it re-sends the same request with `takeOffRun: true` */
  takeOffRun: "Take off run and complete",
} as const;

/** SA-913 R8: the run confirm's sentence, naming the driver the api sent with COUNTER_COMPLETE_ON_RUN. */
export function onDriverRunCopy(driverName: unknown): string {
  const who = typeof driverName === "string" && driverName ? `${driverName}'s` : "a delivery";
  return `This order is on ${who} run. Completing it here takes it off the run.`;
}

/**
 * I-120 (#3689 review MUST 4): the fixed copy of a refused "Complete at counter" (and pickup hand-over), shared by web
 * and mobile, each with its own money formatter; null for a code this does not own. Every one of these refusals happens
 * before the first write and says nothing changed, except the credit and selling-restriction lines: their gates are
 * pre-judged (SA-905 MUST 1), but the authoritative DELIVERED-step gate can still refuse after the switch (the documented
 * residual), so those two never claim it (SA-907 LOW).
 */
export function counterCompleteRefusalCopy(
  body:
    | { code?: unknown; limit?: unknown; exposure?: unknown; driverName?: unknown }
    | null
    | undefined,
  money: (n: number) => string,
): string | null {
  switch (body?.code) {
    // I-120 R8/R9 (owner 7a, SA-913), all refused before any write
    case API_ERROR_CODES.COUNTER_COMPLETE_SHIPPED:
      return "Nothing changed. This order has shipped with the carrier.";
    case API_ERROR_CODES.COUNTER_COMPLETE_ON_RUN:
      // W-778: a question the clerk can answer with "Take off run and complete", not an error, so it never says "Nothing changed."
      return onDriverRunCopy(body.driverName);
    case API_ERROR_CODES.COUNTER_COMPLETE_STOP_STARTED:
      return "Nothing changed. The driver has started this stop. Finish it on the route.";
    // SA-913 R8: the take-off lost a race (a dispatch or the run finishing moved the link); the removal rolled back
    case API_ERROR_CODES.ORDER_RUN_LINK_CHANGED:
      return "Nothing changed. This order's delivery run just changed. Reload and try again.";
    // W-776 (SA-925): the pre-check refused a closed day before any write. W-778: it names where the fix is (the till).
    case API_ERROR_CODES.COUNTER_COMPLETE_DAY_CLOSED:
      return "Nothing changed. This register's day is closed. Ask a manager or owner to reopen it.";
    case API_ERROR_CODES.COUNTER_COMPLETE_UNAVAILABLE:
      return "Nothing changed. This business doesn't hand orders over at the store.";
    case API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED: {
      const figures =
        typeof body.limit === "number" && typeof body.exposure === "number"
          ? ` (${money(body.exposure)} of ${money(body.limit)})`
          : "";
      return `This customer is over their credit limit${figures}. Take payment now, or record a payment first.`;
    }
    case API_ERROR_CODES.SELLING_RESTRICTED:
      return "An item on this order can't be sold at the store. Edit the order, or deliver it.";
    case API_ERROR_CODES.ORDER_ON_ACTIVE_RUN:
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
