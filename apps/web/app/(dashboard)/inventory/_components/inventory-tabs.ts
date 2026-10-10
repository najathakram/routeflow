/** Inventory page tabs and their `?tab=` deep-link rules. */
export type InventoryTab = { value: string; label: string; href?: string };

export const PURCHASE_ORDERS_HREF = "/purchase-orders";

export const INVENTORY_TABS: InventoryTab[] = [
  { value: "stock", label: "Stock" },
  { value: "count", label: "Stock Count" },
  { value: "suppliers", label: "Suppliers" },
  // Purchase orders live on their own route now; the tab stays as a link so it is still findable here.
  { value: "purchase-orders", label: "Purchase Orders", href: PURCHASE_ORDERS_HREF },
  { value: "forecasting", label: "Forecasting" },
];

const PANEL_VALUES = INVENTORY_TABS.filter((t) => !t.href).map((t) => t.value);

/** The tab to show for a URL: known `?tab=` wins, `?amend=` implies count, unknown -> stock.
 *  `?tab=purchase-orders` reports a redirect to the PO route. */
export function resolveInventoryTab(params: { get(name: string): string | null }): {
  tab: string;
  redirect: string | null;
} {
  const tab = params.get("tab");
  if (tab === "purchase-orders") return { tab: "stock", redirect: PURCHASE_ORDERS_HREF };
  if (tab && PANEL_VALUES.includes(tab)) return { tab, redirect: null };
  return { tab: params.get("amend") ? "count" : "stock", redirect: null };
}

/** Query string for a tab so switching tabs keeps the URL shareable (stock is the bare path). */
export function inventoryTabHref(value: string): string {
  return value === "stock" ? "/inventory" : `/inventory?tab=${value}`;
}
