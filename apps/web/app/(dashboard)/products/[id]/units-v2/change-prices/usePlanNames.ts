import * as React from "react";
import type { CustomerPricingWithId, PriceTier, TierRules } from "@routeflow/pricing";
import { useProductCustomerPrices } from "@/lib/api/useProductCustomerPrices";
import { useTierLabels } from "@/lib/api/tier-labels";
import { productTierLabel } from "@/lib/tier-one-label";
import { usePriceDraft } from "../edit/usePriceDraft";

/** What both plan panels share: tier and customer names, the planner's customers and the tenant's tier rules. Tier 1 is the tenant's own label, else Retail (P02). */
export function usePlanNames() {
  const { grid } = usePriceDraft();
  const labels = useTierLabels().data;
  const productId = grid?.productId ?? "";
  const customerPrices = useProductCustomerPrices(productId, productId !== "").data;
  const rows = customerPrices?.customers;
  const customersTruncated = customerPrices?.truncated === true;
  return React.useMemo(() => {
    const names = new Map((rows ?? []).map((c) => [c.customerId, c.name]));
    return {
      tierName: (t: PriceTier) => productTierLabel(labels, t),
      customerName: (id: string) => names.get(id) ?? "A customer",
      customers: (rows ?? []) as CustomerPricingWithId[],
      rules: grid?.tierRules as TierRules | undefined,
      /** The server capped the customers list (K3b NIT-3): the Also update section says so. */
      customersTruncated,
    };
  }, [labels, rows, grid?.tierRules, customersTruncated]);
}
