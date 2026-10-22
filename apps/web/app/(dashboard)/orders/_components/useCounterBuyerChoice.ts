"use client";

import * as React from "react";
import { restoredBuyerKind, type BuyerKind } from "./counter-buyer-choice";

/**
 * S5: whether the clerk has said who is buying, and which way. `kind` is "customer" (a customer was picked),
 * "walk-in" (the explicit tap) or null (not asked yet). Complete waits on `chosen`; the R7b "Put this sale on account"
 * button waits on `kind === "customer"`.
 */
export function useCounterBuyerChoice() {
  const [kind, setKind] = React.useState<BuyerKind>(null);
  const chooseCustomer = React.useCallback(() => setKind("customer"), []);
  const chooseWalkIn = React.useCallback(() => setKind("walk-in"), []);
  /** A new sale starts unanswered. */
  const reset = React.useCallback(() => setKind(null), []);
  /** A restored cart (parked, live, held) puts back the choice it was saved with. */
  const restore = React.useCallback(
    (customer: { isWalkIn?: boolean | null } | null, walkInChosen: boolean) =>
      setKind(restoredBuyerKind(customer, walkInChosen)),
    [],
  );
  return { chosen: kind !== null, kind, chooseCustomer, chooseWalkIn, reset, restore };
}

export type CounterBuyerChoice = ReturnType<typeof useCounterBuyerChoice>;
