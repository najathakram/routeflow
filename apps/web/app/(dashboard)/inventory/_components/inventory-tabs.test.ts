import {
  INVENTORY_TABS,
  PURCHASE_ORDERS_HREF,
  inventoryTabHref,
  resolveInventoryTab,
} from "./inventory-tabs";

const params = (q: string) => new URLSearchParams(q);

describe("inventory ?tab= deep links", () => {
  it.each(INVENTORY_TABS.filter((t) => !t.href).map((t) => t.value))(
    "round-trips the %s tab",
    (value) => {
      const href = inventoryTabHref(value);
      const q = href.split("?")[1] ?? "";
      expect(resolveInventoryTab(params(q))).toEqual({ tab: value, redirect: null });
    },
  );

  it("falls back to Stock for an unknown or missing value", () => {
    expect(resolveInventoryTab(params("tab=nonsense")).tab).toBe("stock");
    expect(resolveInventoryTab(params("")).tab).toBe("stock");
  });

  it("sends ?tab=purchase-orders to the PO route", () => {
    expect(resolveInventoryTab(params("tab=purchase-orders"))).toEqual({
      tab: "stock",
      redirect: PURCHASE_ORDERS_HREF,
    });
    expect(PURCHASE_ORDERS_HREF).toBe("/purchase-orders");
  });

  it("keeps the legacy ?amend= deep link on the count tab", () => {
    expect(resolveInventoryTab(params("amend=abc")).tab).toBe("count");
  });

  it("lists Purchase Orders as a link tab to the route, not a panel", () => {
    const po = INVENTORY_TABS.find((t) => t.label === "Purchase Orders");
    expect(po?.href).toBe("/purchase-orders");
  });
});
