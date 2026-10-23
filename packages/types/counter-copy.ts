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
