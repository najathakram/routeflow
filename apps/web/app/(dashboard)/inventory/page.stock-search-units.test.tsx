/**
 * B1475: the stock search dropdown reads a piece count the way the table does (unitsLabel). A boxed
 * product's stock is stored in PIECES, so "-27 box" (pieces next to the box noun) is wrong.
 */
import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import InventoryPage from "./page";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/inventory",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [{ section: "" }, jest.fn()],
}));
jest.mock("@/lib/hooks/useUrlSearch", () => ({
  useUrlSearch: () => ["ux-pos", jest.fn(), ""],
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));

const stockRows = [
  {
    id: "p-chips",
    name: "UX-pos Chips Box",
    sku: "UX-CHIPS",
    category: "Snacks",
    unit: "box",
    currentStock: -27,
    averageCost: 1,
    totalValue: -27,
    isActive: true,
    unitsPerBox: 24,
    variantName: null,
    parentProductId: null,
    parent: null,
    hasVariants: false,
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
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [] } }),
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
jest.mock("./_components/QuickRestockModal", () => ({ QuickRestockModal: () => null }));

describe("InventoryPage stock search dropdown (B1475)", () => {
  it("never prints a piece count next to the box noun", () => {
    render(<InventoryPage />);
    fireEvent.focus(screen.getByRole("combobox"));
    const option = within(screen.getByRole("listbox")).getByRole("option");
    expect(option).not.toHaveTextContent("-27 box");
    expect(option).toHaveTextContent(/-27\s*pcs/);
  });
});
