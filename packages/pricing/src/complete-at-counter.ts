/**
 * I-120 "Complete at counter" (SA-861 rule 2, SA-872 condition 1): may this staff member finish an order at the store? The
 * till permission (`mayUseTill`, computed by the caller: the api's till predicate, the web/mobile session's) AND a business
 * that hands over at the store, read from the derived fulfilment capability (the PICKUP method, or a counter that is not
 * off), never a profile key. The ONE predicate: the api refuses with it and web + mobile hide the button with it. PLAIN
 * inputs only (a structural type): the api never value-imports @routeflow/types.
 */
export interface CompleteAtCounterInputs {
  mayUseTill: boolean;
  /** `capabilities.fulfilment.methods` */
  methods?: readonly string[] | null;
  /** `capabilities.fulfilment.counter`: "always" | "optional" | "off" */
  counter?: string | null;
}

export function mayCompleteAtCounter(p: CompleteAtCounterInputs | null | undefined): boolean {
  if (!p || p.mayUseTill !== true) return false;
  const pickup = (p.methods ?? []).includes("PICKUP");
  const counter = p.counter === "always" || p.counter === "optional";
  return pickup || counter;
}

/**
 * The pickup hand-over ("Picked up" / "Hand over") is the SAME engine; it is on screen for a PICKUP order once it is
 * CONFIRMED or OUT_FOR_DELIVERY ("ready"). One control per action: "Complete at counter" is never offered beside it.
 */
export function pickupHandOverOffered(
  status: string,
  fulfillPath: string | null | undefined,
): boolean {
  return fulfillPath === "PICKUP" && (status === "CONFIRMED" || status === "OUT_FOR_DELIVERY");
}

export interface CompleteAtCounterOfferInputs extends CompleteAtCounterInputs {
  status: string;
  fulfillPath: string | null | undefined;
  /** a counter sale keeps the till (it was rung up and paid there) */
  counterSale?: boolean | null;
  shippedAt?: string | Date | null;
}

/**
 * I-120 (SA-861 rules 2-3, G7): is "Complete at counter" OFFERED on this order? The permission + capability rule
 * (`mayCompleteAtCounter`), an open order (PENDING / CONFIRMED / OUT_FOR_DELIVERY), not a counter sale, not where the
 * pickup hand-over already shows, and not shipped with the carrier (R9: the api refuses it, COUNTER_COMPLETE_SHIPPED). An
 * order on a driver's run IS offered (SA-913 R8): the api answers COUNTER_COMPLETE_ON_RUN and the client confirms taking it
 * off the run. Web and mobile both read it; the api's own refusals stay authoritative.
 */
export function completeAtCounterOffered(
  p: CompleteAtCounterOfferInputs | null | undefined,
): boolean {
  if (!p || !mayCompleteAtCounter(p)) return false;
  if (p.counterSale === true) return false;
  if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(p.status)) return false;
  if (pickupHandOverOffered(p.status, p.fulfillPath)) return false;
  // R9: the api's COUNTER_COMPLETE_SHIPPED predicate, so the button never offers what is always refused
  const shipped = p.fulfillPath === "SHIP" && (!!p.shippedAt || p.status === "OUT_FOR_DELIVERY");
  return !shipped;
}
