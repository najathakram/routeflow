import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductsPage from "./page";

/**
 * The /products list fed its category dropdown from `useProducts({ limit: 0 })`, which downloads the tenant's
 * WHOLE catalog on every visit just to read the distinct `category` values. The dropdown now reads the
 * dedicated distinct-categories endpoint (`useProductCategories`), so no call on this page uses the
 * limit=0 fetch-all sentinel and the dropdown still offers every category, not only those on the current page.
 */
const mockUseProducts = jest.fn();
const mockUseProductCategories = jest.fn();

const PAGE_ROWS = [
  {
    id: "p1",
    name: "Acme Cola 12oz",
    sku: "ACME-1",
    unit: "Case",
    category: "Beverages",
    pricePerUnit: "30",
    isActive: true,
    currentStock: 10,
  },
];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/products",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: (...args: unknown[]) => mockUseProducts(...args),
  useProductCategories: () => mockUseProductCategories(),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({ ProductCreateModal: () => null }));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({ RestrictMenu: () => null }));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockUseProducts.mockReturnValue({
    data: { data: PAGE_ROWS, meta: { total: 1, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  });
  mockUseProductCategories.mockReturnValue({ data: ["Beverages", "Snacks", "Tobacco"] });
});

describe("/products category dropdown does not fetch the whole catalog", () => {
  it("never calls useProducts with the limit=0 fetch-all sentinel", () => {
    renderWithProviders(<ProductsPage />);
    expect(mockUseProducts).toHaveBeenCalled();
    for (const [params] of mockUseProducts.mock.calls) {
      expect(params?.limit).not.toBe(0);
    }
  });

  it("offers every category from the categories endpoint, not only those on the visible page", () => {
    renderWithProviders(<ProductsPage />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["All Categories", "Beverages", "Snacks", "Tobacco"]),
    );
  });

  it("falls back to the categories on the loaded page while the endpoint has not answered", () => {
    mockUseProductCategories.mockReturnValue({ data: undefined });
    renderWithProviders(<ProductsPage />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["All Categories", "Beverages"]));
    expect(options).not.toContain("Snacks");
  });
});
