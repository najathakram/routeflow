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
