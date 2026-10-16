import type { CustomerChange, LadderView, PricePlan } from "@routeflow/pricing";

// Hand-built fixtures for the Change prices specs. The panels under test only render a PricePlan, so these are
// plain data: the values mean nothing beyond being distinct strings to look for.

export const VIEW: LadderView = {
  anchor: "case",
  tierAnchors: {},
  rows: [
    { ref: "case", label: "Case", factor: 24, kind: "pack", set: [13.91, 12.5, null, null, null] },
    { ref: "can", label: "Can", factor: 1, kind: "base", set: [null, null, null, null, null] },
  ],
};

export const emptyPlan = (over: Partial<PricePlan> = {}): PricePlan => ({
  patches: [],
  undo: [],
  followers: [],
  offers: [],
  customerChanges: [],
  changes: [],
  problems: [],
  view: VIEW,
  ...over,
});

export const customerChange = (n: number, over: Partial<CustomerChange> = {}): CustomerChange => ({
  customerId: `c${n}`,
  ref: "can",
  tier: 1,
  from: 1.13,
  to: 1.07,
  against: false,
  cause: "shape",
  ...over,
});

/** A plan with a tier offer, a customer offer, followers (one against) and four customer changes. */
export const richPlan = (): PricePlan =>
  emptyPlan({
    patches: [{ ref: "case", tier: 1, to: 14.6 }],
    followers: [
      {
        ref: "can",
        label: "Can",
        tier: 1,
        from: 0.58,
        to: 0.61,
        keep: { ref: "can", tier: 1, value: 0.58 },
      },
      {
        ref: "can",
        label: "Can",
        tier: 2,
        from: 0.5,
        to: 0.49,
        keep: { ref: "can", tier: 2, value: 0.5 },
      },
    ],
    offers: [
      {
        kind: "tier",
        ticked: false,
        ref: "case",
        tier: 1,
        tiers: [3],
        value: 14.6,
        warning: "Tier 3 is higher than Retail ($14.60).",
        title: "Set Tier 3 to $14.60 too",
        patches: [{ ref: "case", tier: 3, to: 14.6 }],
      },
      {
        kind: "customer",
        ticked: false,
        title: "Also raise prices set for these customers, in step with their tier (2 prices).",
        moves: [
          { customerId: "c1", ref: "can", tier: 1, from: 1.13, to: 1.2 },
          { customerId: "c2", ref: "case", tier: 1, from: 54, to: 56.7 },
        ],
      },
    ],
    customerChanges: [
      customerChange(1, { against: true, cause: "shape", to: 1.07 }),
      customerChange(2, { against: true, cause: "rounding", to: 1.12 }),
      customerChange(3, { against: true, cause: "rounding", to: 1.12 }),
      customerChange(4, { against: false, to: 1.2 }),
    ],
    changes: [
      { ref: "case", label: "Case", tier: 1, from: 13.91, to: 14.6 },
      { ref: "can", label: "Can", tier: 1, from: 0.58, to: 0.61 },
    ],
  });

/** A plan whose preview has `n` changed prices, to prove Apply stays reachable. */
export const longPlan = (n: number): PricePlan =>
  emptyPlan({
    patches: [{ ref: "case", tier: 1, to: 14.6 }],
    changes: Array.from({ length: n }, (_, i) => ({
      ref: `u${i}`,
      label: `Unit ${i}`,
      tier: 1 as const,
      from: 10 + i,
      to: 20 + i,
    })),
  });
