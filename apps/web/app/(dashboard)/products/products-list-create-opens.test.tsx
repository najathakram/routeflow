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
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({
  ProductCreateModal: ({ onCreated }: { onCreated: (p: { id: string; name: string }) => void }) => (
    <button type="button" onClick={() => onCreated({ id: "new-1", name: "Acme Tea" })}>
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
});

it("opens the new product after Create from the list header", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: "New Product" }));
  await user.click(screen.getByRole("button", { name: "stand-in create" }));
  expect(mockPush).toHaveBeenCalledWith("/products/new-1");
});
