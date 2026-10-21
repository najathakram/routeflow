import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import ProductsPage from "./page";

/**
 * K12 F07 (New product, A3): after Create on /products the operator stayed on the list and had to find the product they
 * just made. Creating from the list now opens the new product. The REAL page mounts; the create modal is a stand-in that
 * reports a created product the way ProductCreateModal's onCreated does.
 */
const mockPush = jest.fn();
const mockNav = jest.fn();
let mockCreated: { id: string; name: string; parentProductId?: string } = {
  id: "new-1",
  name: "Acme Tea",
};

const PRODUCTS = [
  {
    id: "p1",
    name: "Acme Cola 12oz",
    sku: "ACME-1",
    unit: "Case",
    pricePerUnit: "30",
    isActive: true,
    currentStock: 10,
  },
  {
    id: "p2",
    name: "Acme Lime Soda",
    sku: "ACME-2",
    unit: "Case",
    pricePerUnit: "12",
    isActive: true,
    currentStock: 4,
  },
  {
    id: "p3",
    name: "Acme Tracked Item",
    sku: "ACME-3",
    unit: "Case",
    pricePerUnit: "8",
    isActive: true,
    currentStock: 2,
    trackedCategoryId: "c-missing",
  },
];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/products",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    onClick,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        mockNav(href);
      }}
    >
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
    data: { data: PRODUCTS, meta: { total: 3, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  // master: the list reads its category filter from the tenant categories endpoint (limit=0 partial, #3513).
  useProductCategories: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({
  ProductCreateModal: ({
    onCreated,
  }: {
    onCreated: (p: { id: string; name: string; parentProductId?: string }) => void;
  }) => (
    <button type="button" onClick={() => onCreated(mockCreated)}>
      stand-in create
    </button>
  ),
}));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({ RestrictMenu: () => null }));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockCreated = { id: "new-1", name: "Acme Tea" };
});

it("opens the new product after Create from the list header", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: "New Product" }));
  await user.click(screen.getByRole("button", { name: "stand-in create" }));
  expect(mockPush).toHaveBeenCalledWith("/products/new-1");
});

it("opens the FAMILY page with the new variant in view when the product was created with a parent", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: "New Product" }));
  mockCreated = { id: "var-1", name: "Mint", parentProductId: "fam-1" };
  await user.click(screen.getByRole("button", { name: "stand-in create" }));
  expect(mockPush).toHaveBeenCalledWith("/products/fam-1?variant=var-1");
});
