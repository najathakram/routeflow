import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/**
 * SA-1216 round 2: the two places the products page keeps a product's name outside the list rows go
 * through the same name rule: the labels the rule editor shows for the selection (RestrictMenu `names`)
 * and the names listed for products a bulk delete skipped (BulkDeleteSkipReport `nameById`).
 */
const VARIANT = {
  id: "v1",
  kind: "VARIANT",
  name: "Acme Cola 12oz",
  variantName: "Acme Cola 12oz",
  sku: "AC-12",
  unit: "Case",
  pricePerUnit: "24",
  priceTier2: "0",
  priceTier3: "0",
  priceTier4: "0",
  priceTier5: "0",
  isActive: true,
  currentStock: 4,
  parentProductId: "fam-1",
  parent: { name: "Acme Cola" },
};
const FULL = "Acme Cola - Acme Cola 12oz";

const mockBulkDelete = jest.fn();

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
    data: { data: [VARIANT], meta: { total: 1, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useProductCategories: () => ({ data: undefined }),
  previewFamilyMove: jest.fn(),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({
    mutate: jest.fn(),
    mutateAsync: mockBulkDelete,
    isPending: false,
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({ ProductCreateModal: () => null }));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({
  RestrictMenu: ({ names }: { names: Record<string, string> }) => (
    <div data-testid="rule-chips">{Object.values(names).join("|")}</div>
  ),
}));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("@/components/BulkDeleteSkipReport", () => ({
  BulkDeleteSkipReport: ({
    skipped,
    nameById,
  }: {
    skipped: { id: string }[];
    nameById: ReadonlyMap<string, string>;
  }) => (
    <div data-testid="skip-names">{skipped.map((s) => nameById.get(s.id) ?? "").join("|")}</div>
  ),
}));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));
jest.mock("./_components/SectionEditCell", () => ({ SectionEditCell: () => null }));

describe("Products page: selection names use the full-name rule (SA-1216 round 2)", () => {
  beforeEach(() => {
    mockBulkDelete.mockReset();
    mockBulkDelete.mockResolvedValue({ deleted: 0, softDeleted: 0, skipped: [{ id: "v1" }] });
  });

  const selectAll = async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select all"));
    return user;
  };

  it("the rule editor labels the selected variant with the family and the variant", async () => {
    await selectAll();
    expect(screen.getByTestId("rule-chips")).toHaveTextContent(FULL);
  });

  it("the skipped list names a variant the bulk delete refused with the family and the variant", async () => {
    const user = await selectAll();
    await user.click(screen.getByRole("button", { name: /^Delete 1 item/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByTestId("skip-names")).toHaveTextContent(FULL));
  });
});
