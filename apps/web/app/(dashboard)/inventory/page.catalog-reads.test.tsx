/**
 * The Inventory page must not fetch the whole catalog (`useProducts({ limit: 0 })`).
 *
 * - The Adjust Stock / Quick Restock / Forecasting pickers take their active products from the
 *   stock overview the page already loads (it carries id, name, sku, unit, stock, unitsPerBox).
 * - The parent/variant lookup behind "Assign to variants" and the "<Family> - <Variant>" names were the
 *   last catalog read. Both now ride on the stock overview (W-1299), so the page reads no catalog on
 *   any tab.
 * - Create purchase order (opened from Forecasting) gets each product's kind and parent from the same
 *   rows, so it needs no catalog read of its own either.
 */
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
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
    kind: "STANDARD",
    parentProductId: null,
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
    kind: "VARIANT",
    parentProductId: "fam-1",
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
    kind: "STANDARD",
    parentProductId: null,
  },
];
let mockForecast: unknown[] = [];
const mockRecordAdjustment = jest.fn();
jest.mock("@/lib/api/inventory", () => ({
  useStockOverview: () => ({ data: stockRows, isLoading: false }),
  useSuppliers: () => ({ data: [], isLoading: false }),
  useRecordAdjustment: () => ({ mutate: mockRecordAdjustment, isPending: false }),
  useCreateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useForecasting: () => ({ data: mockForecast, isLoading: false }),
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
jest.mock("./_components/PurchaseOrdersCreateModal", () => ({
  CreatePOModal: ({ products }: { products: object[] }) => (
    <pre data-testid="create-po-products">{JSON.stringify(products)}</pre>
  ),
}));
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
  mockForecast = [];
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
    // The page now also has a phone-only Quick restock in its header; this pins the toolbar one.
    fireEvent.click(
      within(screen.getByTestId("stock-toolbar-actions")).getByRole("button", {
        name: /quick restock/i,
      }),
    );
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
    expect(screen.getByRole("button", { name: /^boxed gadget/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^retired gizmo/i })).not.toBeInTheDocument();
  });

  it("Adjust Stock needs a reason and sends it (SA-828)", () => {
    mockRecordAdjustment.mockClear();
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^adjust stock$/i }));
    fireEvent.change(screen.getByPlaceholderText(/type name or sku/i), { target: { value: "g" } });
    fireEvent.click(screen.getByRole("button", { name: /^boxed gadget/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-2" } });
    const save = screen.getByRole("button", { name: /save adjustment/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "DAMAGED" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(mockRecordAdjustment.mock.calls[0][0]).toMatchObject({
      quantity: -2,
      reason: "DAMAGED",
    });
  });

  // W-1299: these two replaced "reads the parent/variant lookup while the Stock tab is showing" and "skips
  // it on another tab". The lookup itself is gone: the stock overview carries the family facts.
  it.each(["stock", "suppliers", "forecasting", "count"])(
    "never reads the catalog on the %s tab",
    (which) => {
      tab = which;
      // The forecasting tab shows toasts, so it needs the provider; the others ignore it.
      render(
        <ToastProvider>
          <InventoryPage />
        </ToastProvider>,
      );
      expect(useProducts).not.toHaveBeenCalled();
    },
  );

  it("never reads the catalog while the Adjust Stock or Quick Restock picker is open", () => {
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^adjust stock$/i }));
    fireEvent.click(
      within(screen.getByTestId("stock-toolbar-actions")).getByRole("button", {
        name: /quick restock/i,
      }),
    );
    expect(useProducts).not.toHaveBeenCalled();
  });

  it("Create PO from Forecasting gets each active product's kind and parent off the stock rows", () => {
    tab = "forecasting";
    mockForecast = [
      {
        productId: "p1",
        name: "Widget",
        currentStock: 4,
        avgDailySales: 2,
        daysRemaining: 2,
        reorderPoint: 10,
        reorderQty: 20,
        needsReorder: true,
      },
    ];
    render(
      <ToastProvider>
        <InventoryPage />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create PO" }));

    expect(JSON.parse(screen.getByTestId("create-po-products").textContent ?? "[]")).toEqual([
      {
        id: "p1",
        name: "Widget",
        sku: "W-1",
        unitsPerBox: null,
        kind: "STANDARD",
        parentProductId: null,
      },
      {
        id: "p2",
        name: "Boxed Gadget",
        sku: "G-1",
        unitsPerBox: 12,
        kind: "VARIANT",
        parentProductId: "fam-1",
      },
    ]);
    expect(useProducts).not.toHaveBeenCalled();
  });
});
