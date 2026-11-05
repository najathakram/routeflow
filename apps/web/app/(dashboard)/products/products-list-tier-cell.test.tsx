import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { setWideViewport } from "@/test-utils/viewport";
import ProductsPage from "./page";

setWideViewport();

/** SA-1092: a stored tier of 0 is "no price of its own". Quick Edit shows it blank, and a clear and its Undo still work. */
const mockSave = jest.fn();

const SODA = {
  id: "p1",
  kind: "STANDALONE",
  name: "Acme Lime Soda",
  sku: "ACME-1",
  unit: "Case",
  pricePerUnit: "24",
  priceTier2: "0",
  priceTier3: "0",
  priceTier4: "0",
  priceTier5: "0",
  isActive: true,
  currentStock: 4,
};
const COLA = { ...SODA, id: "p2", name: "Acme Cola", sku: "ACME-2", priceTier2: "11" };
let mockRows = [SODA];

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
    data: { data: mockRows, meta: { total: 1, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useProductCategories: () => ({ data: undefined }),
  previewFamilyMove: jest.fn(),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: mockSave, isPending: false }),
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

type User = ReturnType<typeof userEvent.setup>;
const saves = () => mockSave.mock.calls.map((c) => c[0] as Record<string, unknown>);
const row = () => screen.getByRole("row", { name: /Acme Lime Soda/ });

async function openList(user: User) {
  renderWithProviders(<ProductsPage />);
  await user.click(screen.getByRole("button", { name: /quick edit/i }));
}

async function clearTier2(user: User) {
  await user.click(within(row()).getByTitle("Click to edit priceTier2"));
  const box = within(row()).getByDisplayValue("22.00");
  await user.clear(box);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  await screen.findByTitle("Undo last change");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [SODA];
  mockSave.mockResolvedValue({ id: "p1" });
});

describe("SA-1092: a cleared tier in Quick Edit", () => {
  it("QT-1: a tier stored as 0 is a blank cell, not 0.00", async () => {
    await openList(userEvent.setup());

    expect(within(row()).getByTitle("Add priceTier2")).toBeInTheDocument();
    expect(within(row()).queryByText("0.00")).toBeNull();
  });

  it("QT-2: clear a tier at 22, Undo, Redo: PATCH 0, then 22.00, then 0", async () => {
    mockRows = [{ ...SODA, priceTier2: "22" }, COLA];
    const user = userEvent.setup();
    await openList(user);
    const cola = screen.getByRole("row", { name: /Acme Cola/ });
    await user.click(within(cola).getByTitle("Click to edit priceTier2"));
    await user.clear(within(cola).getByDisplayValue("11.00"));
    await user.keyboard("11.5{Enter}");
    await screen.findByTitle("Undo last change");
    jest.clearAllMocks();

    await clearTier2(user);
    expect(saves()[0]).toEqual({ id: "p1", priceTier2: "0" });

    await user.click(screen.getByTitle("Undo last change"));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(saves()[1]).toEqual({ id: "p1", priceTier2: "22.00" });

    await user.click(await screen.findByTitle("Redo last undone change"));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3));
    expect(saves()[2]).toEqual({ id: "p1", priceTier2: "0" });
  });

  it("QT-3: type 22 into a blank tier, Undo: PATCH 0, so the tier is blank again and Undone is true", async () => {
    const user = userEvent.setup();
    await openList(user);

    await user.click(within(row()).getByTitle("Add priceTier2"));
    await user.keyboard("22{Enter}");
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(saves()[0]).toMatchObject({ id: "p1", priceTier2: "22" });

    await user.click(await screen.findByTitle("Undo last change"));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(saves()[1].priceTier2).toBe("0");
    expect(await screen.findByText(/Undone: Acme Lime Soda/)).toBeInTheDocument();
  });

  it("QT-4: clear a cell that's already blank: no PATCH", async () => {
    const user = userEvent.setup();
    await openList(user);

    await user.click(within(row()).getByTitle("Add priceTier2"));
    await user.keyboard("{Enter}");

    expect(await within(row()).findByTitle("Add priceTier2")).toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("QT-5: clear Tier 2 with Tier 3 tracking it: Tier 3 follows and the note says so", async () => {
    mockRows = [{ ...SODA, priceTier2: "22", priceTier3: "22", priceTier4: "20" }];
    const user = userEvent.setup();
    await openList(user);

    await user.click(within(row()).getByTitle("Click to edit priceTier2"));
    await user.clear(within(row()).getAllByDisplayValue("22.00")[0]);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(saves()[0]).toEqual({ id: "p1", priceTier2: "0", priceTier3: "0.00" });
    expect(
      await screen.findByText("Also set Tier 3 to follow the list price."),
    ).toBeInTheDocument();
  });
});

describe("Quick Edit's bar after the only edit is undone", () => {
  const redo = () => screen.queryByTitle("Redo last undone change");
  const undo = () => screen.queryByTitle("Undo last change");

  async function editThenUndo(user: User) {
    mockRows = [{ ...SODA, priceTier2: "22" }];
    await openList(user);
    await clearTier2(user);
    await user.click(screen.getByTitle("Undo last change"));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    await screen.findByText(/Undone: Acme Lime Soda/);
  }

  it("QB-1: the bar stays with Redo and no Undo, and names the edit Redo brings back", async () => {
    await editThenUndo(userEvent.setup());

    expect(redo()).toBeInTheDocument();
    expect(undo()).toBeNull();
    expect(screen.getByText("Acme Lime Soda · priceTier2")).toBeInTheDocument();
  });

  it("QB-2: Redo saves the edit again and hands the bar back to Undo", async () => {
    const user = userEvent.setup();
    await editThenUndo(user);

    await user.click(redo() as HTMLElement);

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3));
    expect(saves()[2]).toEqual({ id: "p1", priceTier2: "0" });
    expect(await screen.findByTitle("Undo last change")).toBeInTheDocument();
    expect(redo()).toBeNull();
  });

  it("QB-3: Clear history takes the bar away with only Redo left", async () => {
    const user = userEvent.setup();
    await editThenUndo(user);

    await user.click(screen.getByTitle("Clear history"));

    expect(redo()).toBeNull();
    expect(screen.queryByTitle("Clear history")).toBeNull();
  });

  it("QB-4: there's no bar before any edit", async () => {
    await openList(userEvent.setup());

    expect(screen.queryByTitle("Clear history")).toBeNull();
  });
});
