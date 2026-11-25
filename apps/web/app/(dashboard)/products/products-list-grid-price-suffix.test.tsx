import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/** B1383 (M1): the grid card prices a boxed product per BOX, never per the piece word. */
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
const CANS = { ...BASE, id: "p1", name: "Acme Cola", sku: "AC-1", unit: "can", unitsPerBox: 12 };
const CASES = { ...BASE, id: "p2", name: "Acme Soda", sku: "AS-1", unit: "case", unitsPerBox: 12 };
const EACH = {
  ...BASE,
  id: "p3",
  name: "Acme Lighter",
  sku: "AL-1",
  unit: "each",
  unitsPerBox: null,
};

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
    data: { data: [CANS, CASES, EACH], meta: { total: 3, page: 1, limit: 50, totalPages: 1 } },
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

describe("Products grid card price suffix (B1383)", () => {
  it("a 12-per-box product with a piece unit reads '/ box', not '/ can'", () => {
    renderWithProviders(<ProductsPage />);
    const card = screen.getByText("Acme Cola").closest("div.mt-auto, div") as HTMLElement;
    expect(card.parentElement?.textContent).toContain("/ box");
    expect(card.parentElement?.textContent).not.toContain("/ can");
  });

  it("a pack word and a plain each product keep their own word", () => {
    renderWithProviders(<ProductsPage />);
    expect(screen.getByText("Acme Soda").closest("div")?.parentElement?.textContent).toContain(
      "/ case",
    );
    expect(screen.getByText("Acme Lighter").closest("div")?.parentElement?.textContent).toContain(
      "/ each",
    );
  });
});
