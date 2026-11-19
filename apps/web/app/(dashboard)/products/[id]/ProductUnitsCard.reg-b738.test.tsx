import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

/**
 * REG-B738 (SA-1167 R5): no client could configure a ProductUnit's price. The wrong value is a units card
 * with no price field, or one that drops a tier price from the save. The card must offer all five price fields
 * (base + tiers 2 to 5) on a unit level and send each one to the unit update call.
 */
const updateMutate = jest.fn();

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateProductUnit: () => ({
    mutate: updateMutate,
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useDeleteProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({ data: undefined, isLoading: true, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));

let mockUnits: unknown[] = [];
const product = { id: "p-acme", unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
const caseUnit = {
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
};

const queryClient = createTestQueryClient();
const renderCard = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProductUnitsCard product={product} />
      </ToastProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  jest.resetAllMocks();
  mockUnits = [caseUnit];
});

describe("ProductUnitsCard configures a unit's prices", () => {
  it("REG-B738: a unit level has all five price fields and Save sends every one that was typed", () => {
    renderCard();
    const fields: Array<[string, string, number]> = [
      ["Case price", "price", 500],
      ["Case Tier 2 price", "priceTier2", 450],
      ["Case Tier 3 price", "priceTier3", 440],
      ["Case Tier 4 price", "priceTier4", 430],
      ["Case Tier 5 price", "priceTier5", 420],
    ];
    for (const [label, , value] of fields) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: String(value) } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const body = updateMutate.mock.calls[0][0];
    expect(body).toMatchObject({ id: "u-case", label: "Case", factorToBase: 288 });
    for (const [, key, value] of fields) expect(body[key]).toBe(value);
  });

  it("REG-B738: an untouched unit offers no Save, so no price is written by accident", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
