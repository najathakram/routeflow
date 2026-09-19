import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

const mockEnabled = jest.fn();
const createMutate = jest.fn();
const updateMutate = jest.fn();
const updateMutateAsync = jest.fn().mockResolvedValue({});
const removeMutate = jest.fn();
let mockUnits: unknown[] = [];

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockEnabled(),
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: createMutate, isPending: false }),
  useUpdateProductUnit: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: false,
  }),
  useDeleteProductUnit: () => ({ mutate: removeMutate, isPending: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));

const product = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
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
const palletUnit = {
  ...caseUnit,
  id: "u-pallet",
  label: "Pallet",
  factorToBase: 5760,
  price: "5760.00",
};

function renderCard() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <ProductUnitsCard product={product} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled.mockReturnValue(true);
  mockUnits = [];
});

describe("ProductUnitsCard", () => {
  it("renders nothing at all when the tenant is not granted flag.units_v1", () => {
    mockEnabled.mockReturnValue(false);
    renderCard();
    expect(screen.queryByText("Units & prices")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add unit" })).toBeNull();
  });

  it("shows the pack row and an empty state when no levels exist", () => {
    renderCard();
    expect(screen.getByText("Units & prices")).toBeInTheDocument();
    expect(screen.getByText(/24 pieces/)).toBeInTheDocument();
    expect(screen.getByText(/No other units yet/)).toBeInTheDocument();
  });

  it("adds a unit with its price through the create mutation (Add stays disabled until name + size)", () => {
    renderCard();
    const add = screen.getByRole("button", { name: "Add unit" });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: " Case " } });
    fireEvent.change(screen.getByLabelText("Pieces per unit"), { target: { value: "288" } });
    fireEvent.change(screen.getByLabelText("Price (optional)"), { target: { value: "480" } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(createMutate).toHaveBeenCalledWith(
      { label: "Case", factorToBase: 288, price: 480 },
      expect.any(Object),
    );
  });

  it("lists levels; an unedited row offers no Save, an edited price shows Save and sends the patch", () => {
    mockUnits = [caseUnit];
    renderCard();
    expect(screen.getAllByTestId("unit-row")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u-case", label: "Case", factorToBase: 288, price: 500 }),
      expect.any(Object),
    );
  });

  it("choosing a level as the default patches isDefaultSelling", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(screen.getAllByRole("radio")[1]); // [0] = the pack row's radio
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "u-case", isDefaultSelling: true },
      expect.any(Object),
    );
  });

  it("the yes/no prompt: after a price save that has other explicit-priced levels, Yes updates them, No leaves them", async () => {
    mockUnits = [caseUnit, palletUnit];
    updateMutate.mockImplementation((_b, opts) => opts?.onSuccess?.());
    renderCard();
    const price = screen.getAllByLabelText("Price")[0];
    fireEvent.change(price, { target: { value: "440" } }); // 480 -> 440
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(await screen.findByText("Update the other unit prices too?")).toBeInTheDocument();
    expect(screen.getByText(/Pallet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, update" }));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({ id: "u-pallet", price: 5280 }),
    );
  });

  it("No, leave them writes nothing", async () => {
    mockUnits = [caseUnit, palletUnit];
    updateMutate.mockImplementation((_b, opts) => opts?.onSuccess?.());
    renderCard();
    fireEvent.change(screen.getAllByLabelText("Price")[0], { target: { value: "440" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "No, leave them" }));
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });
});
