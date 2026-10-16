"use client";

import type { CustomerPricingWithId, LadderView, PriceTier, TierRules } from "@routeflow/pricing";
import type { PricePlanWrite } from "./selection";

export interface ChangePricesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: LadderView;
  rules?: TierRules;
  tierName?: (tier: PriceTier) => string;
  customers?: readonly CustomerPricingWithId[];
  customerName?: (customerId: string) => string;
  /** Edit mode: hand the write to the draft instead of the save hook. */
  onApply?: (write: PricePlanWrite) => void | Promise<void>;
  onApplied?: () => void;
}

// STUB (red commit): renders nothing yet.
export function ChangePricesPanel(props: ChangePricesPanelProps) {
  void props;
  return null;
}
