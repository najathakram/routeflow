import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

// Owner ruling D-2026-10-18: under the v2 grid the legacy Units & prices card is read-only; its live controls moved
// beside the grid (UnitsBesideGrid), so nothing is lost. Read-only holds only once the grid has mounted those controls.
let mockUnits: unknown[] = [];
let mockGrid: { data?: unknown; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateProductUnit: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale" } }),
}));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("./PriceWindowHost", () => ({ usePriceWindowOpener: () => ({ open: jest.fn() }) }));

const cells = (v: number[]) =>
  v.map((value, i) => ({ tier: i + 1, value, source: i === 0 ? "set" : "auto" }));
const GRID = {
  productId: "p1",
  anchor: "pack",
  rows: [
    {
      ref: "pack",
      label: "Box",
      factor: 24,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([42, 40, 39, 38, 37]),
    },
    {
      ref: "u-case",
      label: "Case",
      factor: 288,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([480, 470, 460, 450, 440]),
    },
    {
      ref: "base",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([2, 2, 2, 2, 2]),
    },
  ],
};
const unit = (over: Record<string, unknown>) => ({
  id: "u-case",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
  ...over,
});
const product = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };

function renderCard(props: { readOnly?: boolean } = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <ProductUnitsCard product={product} hideAddForm {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUnits = [
    unit({}),
    unit({ id: "u-pallet", label: "Pallet", factorToBase: 5760, isDefaultSelling: true }),
  ];
  mockGrid = { data: GRID, isLoading: false, isError: false };
});

describe("ProductUnitsCard readOnly", () => {
  it("renders no inputs, buttons or radios, but still shows names, sizes, prices and the default badge", () => {
    renderCard({ readOnly: true });
    const card = screen.getByText("Units & prices").closest("[data-units-card]") as HTMLElement;
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(card).queryAllByRole("radio")).toHaveLength(0);
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(within(card).queryByLabelText("New unit")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit prices" })).toBeNull();
    expect(within(card).getByText("Case")).toBeInTheDocument();
    expect(within(card).getByText("Pallet")).toBeInTheDocument();
    expect(within(card).getByText(/288 pieces/)).toBeInTheDocument();
    expect(within(card).getAllByText("$480.00").length).toBeGreaterThan(0);
    expect(within(card).getByText("$42.00")).toBeInTheDocument(); // the pack, as text
    // The default shows as a small text badge on its row only.
    const rows = within(card).getAllByTestId("unit-row");
    expect(within(rows[1]).getByText("Default order unit")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Default order unit")).toBeNull();
  });

  it("badges the pack row when no unit is the default", () => {
    mockUnits = [unit({})];
    renderCard({ readOnly: true });
    expect(screen.getAllByText("Default order unit")).toHaveLength(1);
  });

  it("stays editable until the grid has mounted the controls that replace it", () => {
    mockGrid = { data: undefined, isLoading: true, isError: false };
    renderCard({ readOnly: true });
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Default order unit").length).toBeGreaterThan(0);
  });

  it("without readOnly the card is unchanged: editable Name, default radios and Add", () => {
    mockGrid = { data: undefined, isLoading: true, isError: false };
    renderCard();
    expect(screen.getByLabelText("Case name")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
  });
});
