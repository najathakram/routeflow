/**
 * Inventory perf (cause 1): the Stock table must hand `useSortableData` the SAME comparators
 * object on every render, or its sort memo misses and all rows re-sort on each hover/keystroke.
 */
import * as React from "react";
import { render } from "@testing-library/react";
import InventoryPage from "./page";

let tab = "stock";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(tab === "stock" ? "" : `tab=${tab}`),
  usePathname: () => "/inventory",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [{ section: "" }, jest.fn()],
}));
jest.mock("@/lib/hooks/useUrlSearch", () => ({ useUrlSearch: () => ["", jest.fn(), ""] }));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));

const stockRows = [
  {
    id: "p1",
    name: "Widget",
    sku: "W-1",
    unit: "each",
    currentStock: 4,
    averageCost: 1,
    totalValue: 4,
    isActive: true,
    unitsPerBox: null,
  },
  {
    id: "p2",
    name: "Boxed Gadget",
    sku: "G-1",
    unit: "each",
    currentStock: 24,
    averageCost: 2,
    totalValue: 48,
    isActive: true,
    unitsPerBox: 12,
  },
  {
    id: "p3",
    name: "Retired Gizmo",
    sku: "R-1",
    unit: "each",
    currentStock: 0,
    averageCost: null,
    totalValue: null,
    isActive: false,
    unitsPerBox: null,
  },
];
const mockRecordAdjustment = jest.fn();
jest.mock("@/lib/api/inventory", () => ({
  useStockOverview: () => ({ data: stockRows, isLoading: false }),
  useSuppliers: () => ({ data: [], isLoading: false }),
  useRecordAdjustment: () => ({ mutate: mockRecordAdjustment, isPending: false }),
  useCreateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useForecasting: () => ({ data: [], isLoading: false }),
  useUpdateReorderSettings: () => ({ mutate: jest.fn(), isPending: false }),
  useInventoryValuation: () => ({ data: undefined }),
  useBulkSetCostBasis: () => ({ mutate: jest.fn(), isPending: false }),
  useRecomputeCosts: () => ({ mutate: jest.fn(), isPending: false }),
}));

const useProducts = jest.fn();
jest.mock("@/lib/api/products", () => ({
  useProducts: (...args: unknown[]) => useProducts(...args),
}));

jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/RegulatedScopeTabs", () => ({ RegulatedScopeTabs: () => null }));
jest.mock("@/components/ScanInvoiceModal", () => ({ ScanInvoiceModal: () => null }));
jest.mock("@/components/inventory/StockCountTab", () => ({ StockCountTab: () => null }));
jest.mock("@/components/SetCostModal", () => ({ SetCostModal: () => null }));
jest.mock("@/components/VariantSplitModal", () => ({ VariantSplitModal: () => null }));
jest.mock("./_components/PurchaseOrdersCreateModal", () => ({ CreatePOModal: () => null }));
jest.mock("./_components/QuickRestockModal", () => ({
  QuickRestockModal: ({ products }: { products: { id: string; name: string }[] }) => (
    <ul data-testid="restock-products">
      {products.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  ),
}));

const seen: unknown[] = [];
jest.mock("@/lib/use-sortable-data", () => {
  const actual = jest.requireActual("@/lib/use-sortable-data");
  return {
    ...actual,
    useSortableData: (items: unknown[], opts: { comparators?: unknown }) => {
      seen.push(opts.comparators);
      return actual.useSortableData(items, opts);
    },
  };
});

it("passes the same comparators object on every render", () => {
  useProducts.mockReturnValue({ data: { data: [] } });
  const { rerender } = render(<InventoryPage />);
  rerender(<InventoryPage />);
  rerender(<InventoryPage />);
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(new Set(seen).size).toBe(1);
});
