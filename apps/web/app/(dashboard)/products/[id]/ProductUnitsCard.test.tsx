import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

const mockEnabled = jest.fn();
const createMutate = jest.fn();
const updateMutate = jest.fn();
const updateMutateAsync = jest.fn();
const removeMutate = jest.fn();
let mockUnits: unknown[] = [];

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: (o?: unknown) => mockEnabled(o),
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
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));

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

const queryClient = createTestQueryClient();
function Card() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProductUnitsCard product={product} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
const renderCard = () => render(<Card />);

beforeEach(() => {
  jest.resetAllMocks();
  mockEnabled.mockReturnValue(true);
  updateMutateAsync.mockResolvedValue({});
  mockUnits = [];
});

describe("ProductUnitsCard", () => {
  it("renders nothing when the tenant is not granted flag.units_v1, and only asks for operators", () => {
    mockEnabled.mockReturnValue(false);
    renderCard();
    expect(screen.queryByText("Units & prices")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add unit" })).toBeNull();
    expect(mockEnabled).toHaveBeenCalledWith({ enabled: true }); // OPERATOR
  });

  it("shows the pack row and an empty state when no levels exist", () => {
    renderCard();
    expect(screen.getByText("Units & prices")).toBeInTheDocument();
    expect(screen.getByText(/24 pieces/)).toBeInTheDocument();
    expect(screen.getByText(/No other units yet/)).toBeInTheDocument();
  });

  it("adds a unit through the create mutation (Add stays disabled until name + size); a 0 price is sent as null", () => {
    renderCard();
    const add = screen.getByRole("button", { name: "Add unit" });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: " Case " } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "288" } });
    fireEvent.change(screen.getByLabelText("Price (optional)"), { target: { value: "480" } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(createMutate).toHaveBeenLastCalledWith(
      { label: "Case", factorToBase: 288, price: 480 },
      expect.any(Object),
    );
    fireEvent.change(screen.getByLabelText("Price (optional)"), { target: { value: "0" } });
    fireEvent.click(add);
    expect(createMutate).toHaveBeenLastCalledWith(
      { label: "Case", factorToBase: 288, price: null },
      expect.any(Object),
    );
  });

  it("an unedited row offers no Save; an edited price shows Save and sends the patch", () => {
    mockUnits = [caseUnit];
    renderCard();
    expect(screen.getAllByTestId("unit-row")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u-case", label: "Case", factorToBase: 288, price: 500 }),
      expect.any(Object),
    );
  });

  it("clearing a price sends null (back to derived); typing 0 also sends null, never an explicit $0", () => {
    mockUnits = [caseUnit];
    renderCard();
    const price = screen.getByLabelText("Case price");
    fireEvent.change(price, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: null }),
      expect.any(Object),
    );
    fireEvent.change(price, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: null }),
      expect.any(Object),
    );
  });

  it("the (derived) placeholder previews the DERIVED price, not the explicit price being cleared", () => {
    mockUnits = [caseUnit]; // explicit 480.00; derived = 42 x 288 / 24 = 504
    renderCard();
    expect((screen.getByLabelText("Case price") as HTMLInputElement).placeholder).toBe(
      "$504.00 (derived)",
    );
  });

  it("an invalid draft (blank name or size) cannot be saved", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "Case" } });
    fireEvent.change(screen.getByLabelText("Pieces per Case"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("an in-progress edit survives a re-render with equal server data (refetch) — no silent reset", () => {
    mockUnits = [caseUnit];
    const { rerender } = renderCard();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "500" } });
    mockUnits = [{ ...caseUnit }]; // a fresh object, same values — what a refetch produces
    rerender(<Card />);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
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

  it("Remove asks first, and only deletes on confirm", async () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeMutate).not.toHaveBeenCalled();
    expect(await screen.findByText("Remove Case?")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(removeMutate).toHaveBeenCalledWith("u-case", expect.any(Object));
  });

  it("a save error is shown, with the server's message", async () => {
    mockUnits = [caseUnit];
    updateMutate.mockImplementation((_b, opts) =>
      opts?.onError?.({ response: { data: { message: "size cannot change" } } }),
    );
    renderCard();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("size cannot change")).toBeInTheDocument();
  });

  describe("the yes/no cascade prompt", () => {
    beforeEach(() => {
      mockUnits = [caseUnit, palletUnit];
      updateMutate.mockImplementation((_b, opts) => opts?.onSuccess?.());
    });
    const editCasePrice = () => {
      fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "440" } }); // 480 -> 440
      fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    };

    it("Yes updates the other explicit-priced levels proportionally", async () => {
      renderCard();
      editCasePrice();
      expect(await screen.findByText("Update the other unit prices too?")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Yes, update" }));
      await waitFor(() =>
        expect(updateMutateAsync).toHaveBeenCalledWith({ id: "u-pallet", price: 5280 }),
      );
    });

    it("a tier-2 edit cascades tier 2 to the other levels (not just tier 1)", async () => {
      mockUnits = [
        { ...caseUnit, priceTier2: "440.00" },
        { ...palletUnit, priceTier2: "5280.00" },
      ];
      renderCard();
      // open the Case row's tier disclosure input by its aria-label
      fireEvent.change(screen.getByLabelText("Case Tier 2 price"), { target: { value: "396" } }); // 440 -> 396 (x 0.9)
      fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
      fireEvent.click(await screen.findByRole("button", { name: "Yes, update" }));
      await waitFor(() =>
        expect(updateMutateAsync).toHaveBeenCalledWith({ id: "u-pallet", priceTier2: 4752 }),
      );
    });

    it("No writes nothing", async () => {
      renderCard();
      editCasePrice();
      fireEvent.click(await screen.findByRole("button", { name: "No, leave them" }));
      expect(updateMutateAsync).not.toHaveBeenCalled();
    });

    it("a partial failure reports which units were NOT updated", async () => {
      updateMutateAsync.mockRejectedValue({ response: { data: { message: "nope" } } });
      renderCard();
      editCasePrice();
      fireEvent.click(await screen.findByRole("button", { name: "Yes, update" }));
      expect(await screen.findByText("Updated 0 of 1 other units")).toBeInTheDocument();
      expect(screen.getByText(/Not updated: Pallet/)).toBeInTheDocument();
    });
  });
});
