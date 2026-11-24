import type { POItem } from "../inventory/_components/purchase-orders-shared";

/**
 * A line exactly as `InventoryService.getPurchaseOrder` returns it: the product select is
 * { id, name, unit, unitsPerBox, currentStock, parentProductId, variantName, parent }, and the parent is
 * the tenant-safe view ({ name } only, or null when the link crosses tenants). Decimal columns are strings.
 */
export const realDetailItem: POItem = {
  id: "i1",
  productId: "p1",
  product: {
    id: "p1",
    name: "Strawberry",
    unit: "case",
    unitsPerBox: 12,
    currentStock: "30.000",
    parentProductId: "fam-1",
    variantName: "Strawberry",
    parent: { name: "Acme Vape" },
  },
  qtyOrdered: "12000",
  qtyReceived: "0",
  unitCost: "0.9167",
  totalCost: "11000.00",
  packSize: 12,
};

/** The same line as the read returned it BEFORE the select was widened (no family fields). */
export const oldShapeDetailItem: POItem = {
  ...realDetailItem,
  product: { id: "p1", name: "Strawberry", unit: "case", unitsPerBox: 12 },
};
