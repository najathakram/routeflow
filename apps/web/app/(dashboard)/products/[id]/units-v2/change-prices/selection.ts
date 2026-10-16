import * as React from "react";
import type {
  CellPatch,
  CustomerChange,
  CustomerMoveOffer,
  FollowerRow,
  PriceOffer,
  Pin,
  PricePlan,
} from "@routeflow/pricing";

// What the owner ticked on a PricePlan. Every set starts EMPTY: no offer and no Keep is ever pre-selected
// (SA-799 a, SA-798 c). No price is worked out here; this only picks which of the plan's patches go in the write.

export interface AlsoUpdateSelection {
  offers: ReadonlySet<string>;
  keeps: ReadonlySet<string>;
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

/** The ticks for one panel. `reset` clears everything (a new plan starts unticked). */
export function useAlsoUpdateSelection() {
  const [selection, setSelection] = React.useState<AlsoUpdateSelection>(EMPTY_SELECTION);
  const toggle = (field: keyof AlsoUpdateSelection, key: string, on: boolean) =>
    setSelection((s) => {
      const next = new Set(s[field]);
      if (on) next.add(key);
      else next.delete(key);
      return { ...s, [field]: next };
    });
  return {
    selection,
    toggleOffer: (key: string, on: boolean) => toggle("offers", key, on),
    toggleKeep: (f: FollowerRow, on: boolean) => toggle("keeps", followerKey(f), on),
    toggleCustomerKeep: (c: CustomerChange, on: boolean) =>
      toggle("customerKeeps", customerKeepKey(c), on),
    reset: () => setSelection(EMPTY_SELECTION),
  };
}

/** The one write the save hook gets: K3's base payload plus the revision and the customer moves (lead ruling). */
export interface PricePlanWrite {
  productId: string;
  /** plan.patches, then each ticked tier offer's patches. */
  patches: CellPatch[];
  orderUnit: string;
  /** Each ticked Keep: an Auto cell pinned as set at its old value (P7). */
  keeps: Pin[];
  expectedRevision: number;
  /** The ticked customer offer's moves (empty when it was not ticked). */
  customerMoves: CustomerMoveOffer["moves"];
  /** Customer cells the owner chose to keep at their old price. */
  customerKeeps: CustomerChange[];
  plan: PricePlan;
}

export const STALE_MESSAGE = "Prices changed since you opened this; review and save again";

/** 409 LADDER_REVISION_STALE, however the http client words it. */
export const isStaleRevision = (e: unknown): boolean => {
  const x = e as {
    code?: string;
    status?: number;
    response?: { status?: number; data?: { code?: string } };
  };
  return (
    x?.code === "LADDER_REVISION_STALE" ||
    x?.response?.data?.code === "LADDER_REVISION_STALE" ||
    (x?.status ?? x?.response?.status) === 409
  );
};

export function buildPricePlanWrite(
  plan: PricePlan,
  sel: AlsoUpdateSelection,
  ctx: { productId: string; expectedRevision: number },
): PricePlanWrite {
  const ticked = plan.offers.filter((o) => sel.offers.has(offerKey(o)));
  return {
    ...ctx,
    patches: [...plan.patches, ...ticked.flatMap((o) => (o.kind === "tier" ? o.patches : []))],
    orderUnit: plan.view.anchor,
    keeps: plan.followers.filter((f) => sel.keeps.has(followerKey(f))).map((f) => f.keep),
    customerMoves: ticked.flatMap((o) => (o.kind === "customer" ? o.moves : [])),
    customerKeeps: plan.customerChanges.filter((c) => sel.customerKeeps.has(customerKeepKey(c))),
    plan,
  };
}
