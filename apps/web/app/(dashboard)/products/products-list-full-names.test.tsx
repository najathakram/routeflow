import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/**
 * SA-1216: the products list shows a family variant as "<Family> - <Variant>" in the grid and the
 * table, not as the bare flavor. A standalone product keeps its own name.
 */
const BASE = {
  kind: "STANDALONE",
  unit: "Case",
  pricePerUnit: "24",
  priceTier2: "0",
  priceTier3: "0",
  priceTier4: "0",
  priceTier5: "0",
  isActive: true,
  currentStock: 4,
};
const VARIANT = {
  ...BASE,
  id: "v1",
  kind: "VARIANT",
  name: "Blueberry",
  variantName: "Blueberry",
  sku: "AV-1",
  parentProductId: "fam-1",
  parent: { name: "Acme Vape" },
};
const SOLO = { ...BASE, id: "p2", name: "Acme Lighter", sku: "AL-1" };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/products",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: { data: [VARIANT, SOLO], meta: { total: 2, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useProductCategories: () => ({ data: undefined }),
  previewFamilyMove: jest.fn(),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({ ProductCreateModal: () => null }));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({ RestrictMenu: () => null }));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));
jest.mock("./_components/SectionEditCell", () => ({ SectionEditCell: () => null }));

describe("Products list: full names (SA-1216)", () => {
  it("the grid card reads the family and the variant together", () => {
    renderWithProviders(<ProductsPage />);
    expect(screen.getByText("Acme Vape - Blueberry")).toBeInTheDocument();
    expect(screen.queryByText("Blueberry")).toBeNull();
    expect(screen.getByText("Acme Lighter")).toBeInTheDocument();
  });

  it("the table row reads the family and the variant together", async () => {
    renderWithProviders(<ProductsPage />);
    await userEvent.setup().click(screen.getByTitle("Table view"));
    expect(screen.getByText("Acme Vape - Blueberry")).toBeInTheDocument();
    expect(screen.queryByText("Blueberry")).toBeNull();
  });
});
