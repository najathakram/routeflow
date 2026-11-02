import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/** SA-1082 A-1 on the list: a family's Tier cell asks first. Same harness as products-list-k12.test.tsx. VM-W1. */
const mockPush = jest.fn();
const mockNav = jest.fn();
const mockPreview = jest.fn();
const mockSave = jest.fn();

const PRODUCTS = [
  {
    id: "f1",
    kind: "FAMILY",
    name: "Acme Family",
    sku: "ACME-F",
    unit: "Case",
    pricePerUnit: "24",
    priceTier2: "22",
    isActive: true,
    currentStock: 0,
  },
  {
    id: "p2",
    kind: "STANDALONE",
    name: "Acme Lime Soda",
    sku: "ACME-2",
    unit: "Case",
    pricePerUnit: "12",
    priceTier2: "11",
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
  previewFamilyMove: (...a: unknown[]) => mockPreview(...a),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: mockSave, isPending: false }),
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

const TWO = {
  count: 2,
  variants: [
    { id: "v1", name: "Acme One", from: 22, to: 23 },
    { id: "v2", name: "Acme Two", from: 22, to: 23 },
  ],
  retailFrom: 24,
  retailTo: 24,
};

/** Quick edit on, then a new number in the row's Tier 2 cell. */
async function typeTier(user: ReturnType<typeof userEvent.setup>, value: string, rowName: RegExp) {
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: /quick edit/i }));
  const row = screen.getByRole("row", { name: rowName });
  await user.click(within(row).getByText("22.00"));
  const box = within(row).getByDisplayValue("22.00");
  await user.clear(box);
  await user.type(box, `${value}{Enter}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockResolvedValue({ id: "f1" });
});

describe("VM-W1: a family's price on the products list", () => {
  it("asks first, with only the prices, and Move them sends the ids", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    mockSave.mockResolvedValue({ id: "f1", movedVariants: 2 });
    await typeTier(user, "23", /Acme Family/);
    await user.click(await screen.findByTestId("family-move-confirm"));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(Number(mockPreview.mock.calls[0][1].priceTier2)).toBe(23);
    expect(mockPreview.mock.calls[0][1]).not.toHaveProperty("id");
    expect(mockSave.mock.calls[0][0]).toMatchObject({
      id: "f1",
      priceTier2: expect.anything(),
      moveVariantIds: ["v1", "v2"],
    });
  });

  it("closing the question saves nothing, and the cell stays open", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    await typeTier(user, "23", /Acme Family/);
    await screen.findByTestId("family-move-list");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("family-move-list")).toBeNull());
    expect(mockSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByDisplayValue("23")).toBeEnabled());
  });

  it("a product that isn't a family never asks", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await user.click(screen.getByRole("button", { name: /quick edit/i }));
    const row = screen.getByRole("row", { name: /Acme Lime Soda/ });
    await user.click(within(row).getByText("11.00"));
    const box = within(row).getByDisplayValue("11.00");
    await user.clear(box);
    await user.type(box, "11.5{Enter}");
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockSave.mock.calls[0][0]).not.toHaveProperty("moveVariantIds");
  });
});
