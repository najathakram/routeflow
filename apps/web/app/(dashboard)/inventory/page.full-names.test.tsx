/**
 * SA-1216: a family variant is stored as just its flavor ("Blueberry"). The inventory page shows the
 * family and the variant together ("Acme Vape - Blueberry") on its rows, its search box and its
 * picker, using the catalog it already loads. A standalone product keeps its own name.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
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
let mockSearch = "";
jest.mock("@/lib/hooks/useUrlSearch", () => ({
  useUrlSearch: () => [mockSearch, jest.fn(), ""],
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));

const row = (id: string, name: string, sku: string) => ({
  id,
  name,
  sku,
  category: "Vapes",
  unit: "each",
  currentStock: 5,
  averageCost: 2,
  totalValue: 10,
  isActive: true,
  unitsPerBox: null,
});
const stockRows = [row("v-blue", "Blueberry", "AV-1"), row("p-solo", "Acme Lighter", "AL-1")];

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
  useProducts: () => ({
    data: {
      data: [
        { id: "fam-1", name: "Acme Vape", kind: "FAMILY", parentProductId: null, variants: [{}] },
        {
          id: "v-blue",
          name: "Blueberry",
          variantName: "Blueberry",
          kind: "VARIANT",
          parentProductId: "fam-1",
          parent: { name: "Acme Vape" },
          variants: [],
        },
        { id: "p-solo", name: "Acme Lighter", parentProductId: null, variants: [] },
      ],
    },
  }),
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

describe("InventoryPage: full product names (SA-1216)", () => {
  beforeEach(() => {
    mockSearch = "";
  });

  it("a family variant's row reads the family and the variant together", () => {
    render(<InventoryPage />);
    expect(screen.getAllByText("Acme Vape - Blueberry").length).toBeGreaterThan(0);
    expect(screen.queryByText("Blueberry")).toBeNull();
  });

  it("a standalone product keeps its own name", () => {
    render(<InventoryPage />);
    expect(screen.getAllByText("Acme Lighter").length).toBeGreaterThan(0);
  });

  it("searching the family name finds the variant, and the other product drops out", () => {
    mockSearch = "acme vape";
    render(<InventoryPage />);
    expect(screen.getAllByText("Acme Vape - Blueberry").length).toBeGreaterThan(0);
    expect(screen.queryByText("Acme Lighter")).toBeNull();
  });

  it("searching the flavor still finds it", () => {
    mockSearch = "blueberry";
    render(<InventoryPage />);
    expect(screen.getAllByText("Acme Vape - Blueberry").length).toBeGreaterThan(0);
  });
});
