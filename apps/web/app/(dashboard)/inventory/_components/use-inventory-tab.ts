import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { inventoryTabHref, resolveInventoryTab } from "./inventory-tabs";

/** Active-tab state for the Inventory page: reads `?tab=` once, redirects `?tab=purchase-orders`
 *  to its own route, and keeps the URL shareable as the tab changes. */
export function useInventoryTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialTab] = React.useState(() => resolveInventoryTab(searchParams));
  const [activeTab, setActiveTab] = React.useState(initialTab.tab);
  React.useEffect(() => {
    if (initialTab.redirect) router.replace(initialTab.redirect);
  }, [initialTab.redirect, router]);
  const selectTab = (value: string) => {
    setActiveTab(value);
    window.history.replaceState(null, "", inventoryTabHref(value));
  };
  return { activeTab, selectTab };
}
