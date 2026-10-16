import * as React from "react";
import type { CustomerChange, FollowerRow, PricePlan } from "@routeflow/pricing";
import type { CustomerPriceMove } from "@routeflow/types";

// What the owner ticked on a PricePlan. Every set starts EMPTY: nothing is ever pre-selected (SA-799 a, SA-798 c).
// No price is worked out here; this only picks which of the plan's patches go into the draft.

export interface PlanSelection {
  ticked: readonly boolean[];
  keeps: ReadonlySet<string>;
  customerKeeps: ReadonlySet<string>;
}

export const EMPTY_SELECTION: PlanSelection = {
  ticked: [],
  keeps: new Set(),
  customerKeeps: new Set(),
};

export const followerKey = (f: { ref: string; tier: number }): string => `${f.ref}|${f.tier}`;
export const customerKeepKey = (c: Pick<CustomerChange, "customerId" | "ref" | "tier">): string =>
  `${c.customerId}|${c.ref}|${c.tier}`;
/** A customer Keep is a customer price row (none before) at the price it shows now. */
export const keepMove = (c: CustomerChange): CustomerPriceMove => ({
  customerId: c.customerId,
  ref: c.ref,
  tier: c.tier,
  from: null,
  to: c.from,
});

/** The ticks of the Change prices plan, which is not in the draft until Apply. */
export function usePlanSelection() {
  const [selection, setSelection] = React.useState<PlanSelection>(EMPTY_SELECTION);
  const flip = (field: "keeps" | "customerKeeps", key: string, on: boolean) =>
    setSelection((s) => {
      const next = new Set(s[field]);
      if (on) next.add(key);
      else next.delete(key);
      return { ...s, [field]: next };
    });
  return {
    selection,
    toggleOffer: (i: number, on: boolean) =>
      setSelection((s) => ({ ...s, ticked: Object.assign([...s.ticked], { [i]: on }) })),
    toggleKeep: (f: FollowerRow, on: boolean) => flip("keeps", followerKey(f), on),
    toggleCustomerKeep: (c: CustomerChange, on: boolean) =>
      flip("customerKeeps", customerKeepKey(c), on),
    reset: React.useCallback(() => setSelection(EMPTY_SELECTION), []),
  };
}

/**
 * The plan with the ticked tier offers folded into its patches (the tier offers are consumed), plus what the draft
 * needs for the ticked customer offer and the customer Keeps.
 */
export function foldPlan(plan: PricePlan, sel: PlanSelection) {
  const tier = plan.offers.flatMap((o, i) => (o.kind === "tier" && sel.ticked[i] ? o.patches : []));
  return {
    plan: {
      ...plan,
      patches: [...plan.patches, ...tier],
      offers: plan.offers.filter((o) => o.kind === "customer"),
    },
    customerTicked: plan.offers.some((o, i) => o.kind === "customer" && sel.ticked[i]),
    customerKeeps: plan.customerChanges
      .filter((c) => sel.customerKeeps.has(customerKeepKey(c)))
      .map(keepMove),
  };
}

const AMOUNT = /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/;
/** The typed amount: $, % and spaces are ignored; anything that is not a plain number is NaN (the core refuses it). */
export function parseAmount(text: string): number {
  const t = text.replace(/[$%\s]/g, "");
  return AMOUNT.test(t) ? Number(t.replace(/,/g, "")) : NaN;
}
