import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductsPage from "./page";

/** K12 list-card fixes. Same harness as products-list-keyboard-open.test.tsx. */
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
    variants: [{ id: "v1", name: "Acme Cola Cherry" }],
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
  useProductCategories: () => ({ data: undefined }),
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
});

describe("K12 F19: the card's Add variant is a real tap target", () => {
  it("is at least 44 px tall and wider than its text, not a 10 px label", () => {
    renderWithProviders(<ProductsPage />);
    const btn = screen.getByRole("button", { name: /Add variant/ });
    expect(btn.className).toMatch(/min-h-\[44px\]/);
    expect(btn.className).not.toMatch(/text-\[10px\]/);
    expect(btn.className).toMatch(/px-3/);
  });
});
