import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

/**
 * Row 742 (owner ruling 2026-10-22, "keep structure, drop prices"): under the v2 grid a variant or recipe keeps the old
 * card for unit STRUCTURE only. Every structure control stays (name, size, add, remove, default order unit); no price
 * field, tier field, pack price or cascade is shown, and no write carries a price key.
 */
const createMutate = jest.fn();
const updateMutate = jest.fn();
const removeMutate = jest.fn();
let mockUnits: unknown[] = [];

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: createMutate, isPending: false }),
  useUpdateProductUnit: () => ({ mutate: updateMutate, mutateAsync: jest.fn(), isPending: false }),
  useDeleteProductUnit: () => ({ mutate: removeMutate, isPending: false }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));

// A variant: its prices are governed by the family.
const product = {
  id: "p1",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  parentProductId: "fam-1",
};
const caseUnit = {
  id: "u-case",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  priceTier2: "450.00",
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
};

function renderCard(structureOnly: boolean) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <ProductUnitsCard product={product} hideAddForm structureOnly={structureOnly} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const PRICE_KEYS = ["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"];

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = [caseUnit];
});

describe("ProductUnitsCard structureOnly (row 742)", () => {
  it("is titled Units and shows no price, tier price, pack price or price hint", () => {
    renderCard(true);
    expect(screen.getByText("Units")).toBeInTheDocument();
    expect(screen.queryByText("Units & prices")).toBeNull();
    expect(screen.queryByLabelText("Case price")).toBeNull();
    expect(screen.queryByText("Tier prices")).toBeNull();
    expect(screen.queryByLabelText("Price (optional)")).toBeNull();
    expect(screen.queryByText("$42.00")).toBeNull();
    expect(screen.queryByText(/edit its price above/)).toBeNull();
    expect(screen.queryByText(/A grey figure is worked out automatically/)).toBeNull();
  });

  it("keeps every structure control: name, size, default order unit, remove, add", () => {
    renderCard(true);
    expect(screen.getByLabelText("Case name")).toBeEnabled();
    expect(screen.getByLabelText("Pieces per Case")).toBeEnabled();
    expect(screen.getAllByRole("radio", { name: "Default order unit" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByLabelText("New unit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
  });

  it("a rename saves name and size only: no price key, no cascade offer", () => {
    renderCard(true);
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "Crate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const [body, opts] = updateMutate.mock.calls[0];
    expect(body).toEqual({ id: "u-case", label: "Crate", factorToBase: 288 });
    for (const k of PRICE_KEYS) expect(body).not.toHaveProperty(k);
    opts.onSuccess({});
    expect(screen.queryByText("Update the other unit prices too?")).toBeNull();
  });

  it("adding a unit sends no price", () => {
    renderCard(true);
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: "Pallet" } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "5760" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    const [body] = createMutate.mock.calls[0];
    expect(body).toEqual({ label: "Pallet", factorToBase: 5760 });
  });

  it("control: without structureOnly the same card still edits prices (non-v2 tenants keep their only price editor)", () => {
    renderCard(false);
    expect(screen.getByText("Units & prices")).toBeInTheDocument();
    expect(screen.getByLabelText("Case price")).toBeInTheDocument();
    expect(screen.getByText("Tier prices")).toBeInTheDocument();
    expect(screen.getByLabelText("Price (optional)")).toBeInTheDocument();
  });
});
