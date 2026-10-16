import * as React from "react";
import type { CustomerPricingWithId, PriceTier, TierRules } from "@routeflow/pricing";
import { useProductCustomerPrices } from "@/lib/api/useProductCustomerPrices";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { usePriceDraft } from "../edit/usePriceDraft";

/** What both plan panels share: tier and customer names, the planner's customers and the tenant's tier rules. */
export function usePlanNames() {
  const { grid } = usePriceDraft();
  const labels = useTierLabels().data;
  const productId = grid?.productId ?? "";
  const rows = useProductCustomerPrices(productId, productId !== "").data?.customers;
  return React.useMemo(() => {
    const names = new Map((rows ?? []).map((c) => [c.customerId, c.name]));
    return {
      tierName: (t: PriceTier) => (t === 1 ? "Retail" : tierLabel(labels, t)),
      customerName: (id: string) => names.get(id) ?? "A customer",
      customers: (rows ?? []) as CustomerPricingWithId[],
      rules: grid?.tierRules as TierRules | undefined,
    };
  }, [labels, rows, grid?.tierRules]);
}
