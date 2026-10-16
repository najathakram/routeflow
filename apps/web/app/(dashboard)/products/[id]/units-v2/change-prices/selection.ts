import * as React from "react";
import type {
  CellPatch,
  CustomerChange,
  CustomerMoveOffer,
  FollowerRow,
  PriceOffer,
  PricePlan,
} from "@routeflow/pricing";

// What the owner ticked on a PricePlan. Every set starts EMPTY: no offer and no Keep is ever pre-selected
// (SA-799 a, SA-798 c). No price is worked out here: the plan comes from @routeflow/pricing and this file only
// picks which of its patches go into the one write.

export interface AlsoUpdateSelection {
  /** Keys from `offerKey`. */
  offers: ReadonlySet<string>;
  /** Keys from `followerKey`: Auto cells pinned as set at their old value (P7 Keep). */
  keeps: ReadonlySet<string>;
  /** Keys from `customerKeepKey`: customer cells kept at their old price. */
  customerKeeps: ReadonlySet<string>;
}

export const EMPTY_SELECTION: AlsoUpdateSelection = {
  offers: new Set(),
  keeps: new Set(),
  customerKeeps: new Set(),
};

export const offerKey = (o: PriceOffer): string =>
  o.kind === "tier" ? `tier:${o.ref}:${o.tier}` : "customer";
export const followerKey = (f: { ref: string; tier: number }): string => `${f.ref}|${f.tier}`;
export const customerKeepKey = (c: Pick<CustomerChange, "customerId" | "ref" | "tier">): string =>
  `${c.customerId}|${c.ref}|${c.tier}`;

const toggled = (set: ReadonlySet<string>, key: string, on: boolean): Set<string> => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

/** The ticks for one panel. `reset` clears everything (a new plan starts unticked). */
export function useAlsoUpdateSelection() {
  const [selection, setSelection] = React.useState<AlsoUpdateSelection>(EMPTY_SELECTION);
  return {
    selection,
    toggleOffer: (key: string, on: boolean) =>
      setSelection((s) => ({ ...s, offers: toggled(s.offers, key, on) })),
    toggleKeep: (f: FollowerRow, on: boolean) =>
      setSelection((s) => ({ ...s, keeps: toggled(s.keeps, followerKey(f), on) })),
    toggleCustomerKeep: (c: CustomerChange, on: boolean) =>
      setSelection((s) => ({
        ...s,
        customerKeeps: toggled(s.customerKeeps, customerKeepKey(c), on),
      })),
    reset: () => setSelection(EMPTY_SELECTION),
  };
}

/** The one write the save hook gets: the plan plus exactly what was ticked. */
export interface PricePlanWrite {
  plan: PricePlan;
  /** plan.patches, then each ticked tier offer's patches, then each Keep as a set cell at its old value. */
  patches: CellPatch[];
  /** The ticked customer offer's moves (empty when it was not ticked). */
  customerMoves: CustomerMoveOffer["moves"];
  /** Customer cells the owner chose to keep at their old price. */
  customerKeeps: CustomerChange[];
}

export function buildPricePlanWrite(plan: PricePlan, sel: AlsoUpdateSelection): PricePlanWrite {
  const patches: CellPatch[] = [...plan.patches];
  let customerMoves: CustomerMoveOffer["moves"] = [];
  for (const o of plan.offers) {
    if (!sel.offers.has(offerKey(o))) continue;
    if (o.kind === "tier") patches.push(...o.patches);
    else customerMoves = o.moves;
  }
  for (const f of plan.followers) {
    if (sel.keeps.has(followerKey(f)))
      patches.push({ ref: f.keep.ref, tier: f.keep.tier, to: f.keep.value });
  }
  return {
    plan,
    patches,
    customerMoves,
    customerKeeps: plan.customerChanges.filter((c) => sel.customerKeeps.has(customerKeepKey(c))),
  };
}
