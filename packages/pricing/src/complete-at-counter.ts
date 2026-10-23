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

/**
 * OWNER-QUEUE 7a (SA-861 Q1/Q2, rows R8/R9): until the owner answers, an order already with a driver (OUT_FOR_DELIVERY
 * on a route or with a carrier, Q1) and a shipped order (`shippedAt` set, Q2) are not offered. ONE branch: set this to
 * false (and give each case its answered rule) when Q1/Q2 land.
 */
export const COMPLETE_AT_COUNTER_AWAITS_OWNER_7A = true;

export interface CompleteAtCounterOfferInputs extends CompleteAtCounterInputs {
  status: string;
  fulfillPath: string | null | undefined;
  /** a counter sale keeps the till (it was rung up and paid there) */
  counterSale?: boolean | null;
  shippedAt?: string | Date | null;
  /** the order's route run status (`order.routeRun?.status`), when it is on one */
  runStatus?: string | null;
}

/**
 * I-120 (SA-861 rules 2-3, G7): is "Complete at counter" OFFERED on this order? The permission + capability rule
 * (`mayCompleteAtCounter`), an open order (PENDING / CONFIRMED / OUT_FOR_DELIVERY), not a counter sale, not where the
 * pickup hand-over already shows, and not an OWNER-QUEUE 7a case. Web and mobile both read it; the api's own refusals
 * stay authoritative.
 */
export function completeAtCounterOffered(
  p: CompleteAtCounterOfferInputs | null | undefined,
): boolean {
  if (!p || !mayCompleteAtCounter(p)) return false;
  if (p.counterSale === true) return false;
  if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(p.status)) return false;
  if (pickupHandOverOffered(p.status, p.fulfillPath)) return false;
  if (COMPLETE_AT_COUNTER_AWAITS_OWNER_7A) {
    const withDriver = p.status === "OUT_FOR_DELIVERY" && p.fulfillPath !== "PICKUP"; // R8 / Q1
    // R8 / Q1 (SA-905 LOW): on an ACTIVE run; the server refuses the switch ("Remove it from the run" first)
    const onActiveRun = p.runStatus === "SCHEDULED" || p.runStatus === "IN_PROGRESS";
    const shipped = p.fulfillPath === "SHIP" && !!p.shippedAt; // R9 / Q2
    if (withDriver || onActiveRun || shipped) return false;
  }
  return true;
}
