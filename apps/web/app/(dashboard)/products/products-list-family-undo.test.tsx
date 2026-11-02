import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/** SA-1082 A-5: the list's Undo and Redo are family saves too, so they ask. Same harness as products-list-family-ask.test.tsx. */
const mockPreview = jest.fn();
const mockSave = jest.fn();

const FAMILY = {
  id: "f1",
  kind: "FAMILY",
  name: "Acme Family",
  sku: "ACME-F",
  unit: "Case",
  pricePerUnit: "24",
  priceTier2: "22",
  isActive: true,
  currentStock: 0,
};
const SODA = {
  id: "p2",
  kind: "STANDALONE",
  name: "Acme Lime Soda",
  sku: "ACME-2",
  unit: "Case",
  pricePerUnit: "12",
  priceTier2: "11",
  isActive: true,
  currentStock: 4,
};
let mockRows = [FAMILY, SODA];

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
    data: { data: mockRows, meta: { total: 2, page: 1, limit: 50, totalPages: 1 } },
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
  useTrackedCategories: () => ({ data: [{ id: "c1", name: "Acme Section", active: true }] }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({ ProductCreateModal: () => null }));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({ RestrictMenu: () => null }));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));
jest.mock("./_components/SectionEditCell", () => ({
  SectionEditCell: ({
    productName,
    onSave,
  }: {
    productName: string;
    onSave: (patch: Record<string, unknown>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSave({ trackedCategoryId: "c1", trackedSubcategoryId: null })}
    >
      Set section of {productName}
    </button>
  ),
}));

const ONE = {
  count: 1,
  variants: [{ id: "v1", name: "Acme One", from: 21, to: 22 }],
  retailFrom: 24,
  retailTo: 24,
};
const NOBODY = { count: 0, variants: [], retailFrom: 24, retailTo: 24 };

type User = ReturnType<typeof userEvent.setup>;
const saves = () => mockSave.mock.calls.map((c) => c[0] as Record<string, unknown>);

async function openList(user: User) {
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: /quick edit/i }));
}

async function typeTier(user: User, rowName: RegExp, from: string, to: string) {
  const row = screen.getByRole("row", { name: rowName });
  await user.click(within(row).getByText(from));
  const box = within(row).getByDisplayValue(from);
  await user.clear(box);
  await user.type(box, `${to}{Enter}`);
}

/** Family Tier 2 from 22 to 21, Move them: the one save every row starts from. */
async function moveFamily(user: User) {
  mockPreview.mockResolvedValue(ONE);
  mockSave.mockResolvedValue({ id: "f1", movedVariants: 1 });
  await typeTier(user, /Acme Family/, "22.00", "21");
  await user.click(await screen.findByTestId("family-move-confirm"));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  await screen.findByTitle("Undo last change");
  jest.clearAllMocks();
}

const undo = (user: User) => user.click(screen.getByTitle("Undo last change"));

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [FAMILY, SODA];
  mockSave.mockResolvedValue({ id: "f1" });
});

describe("SA-1082 A-5: Undo and Redo on a family ask", () => {
  it("VM-15: Undo, Move: the save takes the family back with the variant's id, and the toast names the move", async () => {
    const user = userEvent.setup();
    await openList(user);
    await moveFamily(user);
    mockPreview.mockResolvedValue(ONE);
    mockSave.mockResolvedValue({ id: "f1", movedVariants: 1 });

    await undo(user);
    await user.click(await screen.findByTestId("family-move-confirm"));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockPreview.mock.calls[0][0]).toBe("f1");
    expect(mockPreview.mock.calls[0][1].priceTier2).toBe(saves()[0].priceTier2);
    expect(saves()[0]).toMatchObject({ id: "f1", moveVariantIds: ["v1"] });
    expect(Number(saves()[0].priceTier2)).toBe(22);
    expect(await screen.findByText("1 variant moved.")).toBeInTheDocument();
    expect(screen.getByText(/Undone: Acme Family/)).toBeInTheDocument();
  });

  it("VM-16: Redo, Move: the save takes the family forward with the variant's id", async () => {
    const user = userEvent.setup();
    await openList(user);
    // The bar leaves with the last Undo, so Redo needs an earlier edit under it.
    mockSave.mockResolvedValue({ id: "p2" });
    await typeTier(user, /Acme Lime Soda/, "11.00", "11.5");
    await screen.findByTitle("Undo last change");
    jest.clearAllMocks();
    await moveFamily(user);
    mockPreview.mockResolvedValue(ONE);
    mockSave.mockResolvedValue({ id: "f1", movedVariants: 1 });
    await undo(user);
    await user.click(await screen.findByTestId("family-move-confirm"));
    await screen.findByTitle("Redo last undone change");
    jest.clearAllMocks();
    mockPreview.mockResolvedValue(ONE);
    mockSave.mockResolvedValue({ id: "f1", movedVariants: 1 });

    await user.click(screen.getByTitle("Redo last undone change"));
    await user.click(await screen.findByTestId("family-move-confirm"));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(saves()[0]).toMatchObject({ id: "f1", moveVariantIds: ["v1"] });
    expect(Number(saves()[0].priceTier2)).toBe(21);
    expect(await screen.findByText(/Redone: Acme Family/)).toBeInTheDocument();
  });

  it("VM-17: Undo, close: no save, and the record is still on the Undo stack", async () => {
    const user = userEvent.setup();
    await openList(user);
    await moveFamily(user);
    mockPreview.mockResolvedValue(ONE);

    await undo(user);
    await screen.findByTestId("family-move-list");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("family-move-list")).toBeNull());

    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Redo last undone change")).toBeNull();
    await undo(user);
    expect(await screen.findByTestId("family-move-list")).toBeInTheDocument();
  });

  it("VM-17: Undo with a failed read: no save, and the record is still on the Undo stack", async () => {
    const user = userEvent.setup();
    await openList(user);
    await moveFamily(user);
    mockPreview.mockRejectedValue(new Error("network"));

    await undo(user);

    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Couldn't save the family price")).toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByTitle("Undo last change")).toBeInTheDocument();
  });

  it("VM-17: Undo, Keep: the family goes back and no id is sent", async () => {
    const user = userEvent.setup();
    await openList(user);
    await moveFamily(user);
    mockPreview.mockResolvedValue(ONE);

    await undo(user);
    await user.click(await screen.findByTestId("family-move-keep"));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(Number(saves()[0].priceTier2)).toBe(22);
    expect(saves()[0]).not.toHaveProperty("moveVariantIds");
    expect(await screen.findByText(/Undone: Acme Family/)).toBeInTheDocument();
  });

  it("VM-18: nobody at the family's price any more: no question, the family alone goes back", async () => {
    const user = userEvent.setup();
    await openList(user);
    await moveFamily(user);
    mockPreview.mockResolvedValue(NOBODY);

    await undo(user);

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("family-move-list")).toBeNull();
    expect(saves()[0]).not.toHaveProperty("moveVariantIds");
  });

  it("VM-19: Undo on a product that isn't a family: no question, the same save", async () => {
    const user = userEvent.setup();
    await openList(user);
    mockSave.mockResolvedValue({ id: "p2" });
    await typeTier(user, /Acme Lime Soda/, "11.00", "11.5");
    await screen.findByTitle("Undo last change");
    jest.clearAllMocks();

    await undo(user);

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockPreview).not.toHaveBeenCalled();
    expect(saves()[0]).toMatchObject({ id: "p2" });
    expect(Number(saves()[0].priceTier2)).toBe(11);
    expect(saves()[0]).not.toHaveProperty("moveVariantIds");
  });

  it("VM-19: Undo of a family's section: no question, the same save", async () => {
    const user = userEvent.setup();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Set section of Acme Family" }));
    await screen.findByTitle("Undo last change");
    jest.clearAllMocks();

    await undo(user);

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockPreview).not.toHaveBeenCalled();
    expect(saves()[0]).toEqual({
      id: "f1",
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      regItemType: null,
      regUomCase: null,
      regUomUnit: null,
    });
  });

  it("VM-19: a family row no longer on the page still asks", async () => {
    const user = userEvent.setup();
    await openList(user);
    mockPreview.mockResolvedValue(ONE);
    mockSave.mockImplementation(async () => {
      mockRows = [SODA];
      return { id: "f1", movedVariants: 1 };
    });
    await typeTier(user, /Acme Family/, "22.00", "21");
    await user.click(await screen.findByTestId("family-move-confirm"));
    await screen.findByTitle("Undo last change");
    await waitFor(() => expect(screen.queryByRole("row", { name: /Acme Family/ })).toBeNull());
    jest.clearAllMocks();
    mockPreview.mockResolvedValue(ONE);

    await undo(user);

    expect(await screen.findByTestId("family-move-list")).toBeInTheDocument();
    expect(mockPreview.mock.calls[0][0]).toBe("f1");
  });
});
