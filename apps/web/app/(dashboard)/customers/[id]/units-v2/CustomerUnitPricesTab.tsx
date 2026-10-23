"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { CustomerPriceView } from "../../../products/[id]/units-v2/customer/CustomerPriceView";

/**
 * The customer page's "Unit prices" tab (units v2, K6). Both halves render NOTHING unless the tenant has
 * `flag.units_prices_v2` and the user is staff, so with the flag off the customer page is byte-identical.
 */
function useUnitPricesTabAllowed(): boolean {
  const { user } = useAuth();
  const staff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  return usePricesV2Enabled({ enabled: staff }) && staff;
}

export function UnitPricesTabTrigger() {
  if (!useUnitPricesTabAllowed()) return null;
  return (
    <Tabs.Trigger
      value="unit-prices"
      className={cn(
        "-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/70 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
      Unit prices
    </Tabs.Trigger>
  );
}

export function UnitPricesTabContent({ customerId }: { customerId: string }) {
  if (!useUnitPricesTabAllowed()) return null;
  return (
    <Tabs.Content value="unit-prices" className="mt-5 focus:outline-none">
      <CustomerPriceView customerId={customerId} />
    </Tabs.Content>
  );
}
