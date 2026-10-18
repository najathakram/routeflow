import {
  explainMove,
  type CellChange,
  type LadderView,
  type PriceChange,
  type PricePlan,
  type PriceTier,
  type TierRules,
} from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";

// K11-17: a Change prices preview row that moves against the chosen direction says why. The reason itself is the pricing
// package's (`explainMove` knows which Set price an Auto price follows); this only words it. No money is worked out here.

export const NO_REASON = "This price follows another price that is not moving.";

/** A Raise that shows a lower price, or a Lower that shows a higher one. */
export const movesAgainst = (
  direction: PriceChange["direction"],
  c: Pick<CellChange, "from" | "to">,
): boolean => (direction === "raise" ? c.to < c.from : c.to > c.from);

export function againstReason({
  view,
  rules,
  plan,
  change,
  direction,
  also,
  tierName,
}: {
  /** The ladder before the change. */
  view: LadderView;
  rules: TierRules;
  plan: Pick<PricePlan, "changes">;
  change: CellChange;
  direction: PriceChange["direction"];
  /** "Also raise the prices you set" is already ticked. */
  also: boolean;
  tierName: (tier: PriceTier) => string;
}): string {
  const why = explainMove(view, rules, change, plan.changes);
  if (!why) return NO_REASON;
  const follows = `Follows ${tierName(why.tier)} ${why.label} ${formatMoney(why.value)}, which you set.`;
  return also ? follows : `${follows} Tick "Also ${direction} the prices you set" to move it.`;
}
