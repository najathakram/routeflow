/**
 * The Inventory page must not fetch the whole catalog (`useProducts({ limit: 0 })`).
 *
 * - The Adjust Stock / Quick Restock / Forecasting pickers take their active products from the
 *   stock overview the page already loads (it carries id, name, sku, unit, stock, unitsPerBox).
 * - The only remaining catalog read is the parent/variant lookup behind "Assign to variants",
 *   which lives on the Stock tab, so it is enabled only while that tab is showing.
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
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
jest.mock("@/lib/api/inventory", () => ({
  useStockOverview: () => ({ data: stockRows, isLoading: false }),
  useSuppliers: () => ({ data: [], isLoading: false }),
  useRecordAdjustment: () => ({ mutate: jest.fn(), isPending: false }),
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

beforeEach(() => {
  tab = "stock";
  useProducts.mockReset();
  useProducts.mockReturnValue({ data: { data: [] } });
});

describe("InventoryPage catalog reads", () => {
  it("does not run a separate active-products list for the pickers", () => {
    render(<InventoryPage />);
    for (const [params] of useProducts.mock.calls) {
      expect(params?.isActive).toBeUndefined();
    }
  });

  it("Quick Restock offers the active products from the stock overview", () => {
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole("button", { name: /quick restock/i }));
    const list = screen.getByTestId("restock-products");
    expect(list).toHaveTextContent("Widget");
    expect(list).toHaveTextContent("Boxed Gadget");
    expect(list).not.toHaveTextContent("Retired Gizmo");
  });

  it("Adjust Stock searches the active products from the stock overview", () => {
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^adjust stock$/i }));
    const input = screen.getByPlaceholderText(/type name or sku/i);
    fireEvent.change(input, { target: { value: "g" } });
    expect(screen.getByRole("button", { name: /boxed gadget/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retired gizmo/i })).not.toBeInTheDocument();
  });

  it("reads the parent/variant lookup while the Stock tab is showing", () => {
    render(<InventoryPage />);
    expect(useProducts).toHaveBeenCalled();
    for (const [params, options] of useProducts.mock.calls) {
      expect(params).toEqual({ includeVariants: true, limit: 0 });
      expect(options?.enabled).toBe(true);
    }
  });

  it("skips the parent/variant lookup on another tab", () => {
    tab = "suppliers";
    render(<InventoryPage />);
    expect(useProducts).toHaveBeenCalled();
    for (const [, options] of useProducts.mock.calls) {
      expect(options?.enabled).toBe(false);
    }
  });
});
