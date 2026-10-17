import * as React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// K10d: the card reads the same price grid the v2 shell does, to know whether the shell has mounted its controls.
let mockGrid: { data?: unknown; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: true,
  isError: false,
};
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
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
  mockGrid = { data: undefined, isLoading: true, isError: false };
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

  it("S5: the default radio is called Default order unit (one on the pack row, one on the Case row)", () => {
    mockUnits = [caseUnit];
    renderCard();
    expect(screen.getAllByLabelText("Default order unit")).toHaveLength(2);
    expect(screen.queryByLabelText("Pre-selected on staff orders")).toBeNull();
    expect(screen.queryByText(/sells by default/i)).toBeNull();
  });

  it("S5: the smallest unit's size field never reads 'Pieces per piece'", () => {
    mockUnits = [{ ...caseUnit, id: "u-piece", label: "Piece", factorToBase: 1, price: null }];
    renderCard();
    expect(screen.queryByText(/pieces per piece/i)).toBeNull();
    expect(screen.queryByLabelText(/pieces per piece/i)).toBeNull();
    expect(screen.getByLabelText("Smallest unit size")).toBeDisabled();
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

  it("the placeholder previews the DERIVED price, not the explicit price being cleared", () => {
    mockUnits = [caseUnit]; // explicit 480.00; derived = 42 x 288 / 24 = 504
    renderCard();
    expect((screen.getByLabelText("Case price") as HTMLInputElement).placeholder).toBe("$504.00");
  });

  it("B594: no placeholder carries a wordy suffix (it clipped in the 2-col grid at 390px); the card explains it once", () => {
    mockUnits = [caseUnit];
    renderCard();
    for (const name of ["Case price", "Case Tier 2 price", "Case Tier 3 price"]) {
      const ph = (screen.getByLabelText(name) as HTMLInputElement).placeholder;
      expect(ph).not.toMatch(/derived/i);
      expect(ph.length).toBeLessThanOrEqual(10);
    }
    expect(screen.getAllByText(/worked out automatically from the box price/i)).toHaveLength(1);
    expect(screen.queryByText(/derived from the box price/i)).toBeNull();
    expect(screen.getByText(/clear it to go back to automatic/i)).toBeInTheDocument();
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

  it("SA-810: a level saved while the unit list is full says its name wasn't added (the level still saved)", async () => {
    createMutate.mockImplementation((_b, opts) =>
      opts?.onSuccess?.({ ...caseUnit, label: "Crate", unitNotListed: ["Crate"] }),
    );
    renderCard();
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: "Crate" } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    expect(
      await screen.findByText(
        "Saved. 'Crate' wasn't added to your unit list because the list is full (200).",
      ),
    ).toBeInTheDocument();
  });

  it("B594: a failed write raises NO toast of its own — the global MutationCache handler already shows the server's message once", async () => {
    mockUnits = [caseUnit];
    const err = { response: { data: { message: "size cannot change" } } };
    updateMutate.mockImplementation((_b, opts) => opts?.onError?.(err));
    createMutate.mockImplementation((_b, opts) => opts?.onError?.(err));
    removeMutate.mockImplementation((_id, opts) => opts?.onError?.(err));
    renderCard();
    // save
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // add
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: "Pallet" } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "5760" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    // remove (the confirm dialog closes on failure)
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(updateMutate).toHaveBeenCalled();
    expect(createMutate).toHaveBeenCalled();
    expect(removeMutate).toHaveBeenCalled();
    expect(screen.queryByText("size cannot change")).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't/)).not.toBeInTheDocument();
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

describe("ProductUnitsCard on the v2 surface (K10d: one Add a unit, one Remove per row)", () => {
  const gridRow = (ref: string, kind: "pack" | "base" | "unit", editable = true) => ({
    ref,
    label: ref,
    factor: 1,
    kind,
    code: null,
    cells: [],
    editable,
  });
  const loaded = (...rows: ReturnType<typeof gridRow>[]) => {
    mockGrid = { data: { rows }, isLoading: false, isError: false };
  };
  const renderWith = (props: Record<string, unknown>, p: Record<string, unknown> = product) =>
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ProductUnitsCard product={p as typeof product} {...props} />
        </ToastProvider>
      </QueryClientProvider>,
    );

  it("hideAddForm drops the always-open Add unit form once the grid has loaded, and keeps every row control", () => {
    mockUnits = [caseUnit];
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit"));
    renderWith({ hideAddForm: true });
    expect(screen.queryByRole("button", { name: "Add unit" })).toBeNull();
    expect(screen.queryByLabelText("New unit")).toBeNull();
    expect(document.getElementById("new-unit-name")).toBeNull();
    expect(screen.getByLabelText("Case name")).toBeInTheDocument();
    expect(screen.getByLabelText("Case price")).toBeInTheDocument();
  });

  it.each([
    ["loading", { data: undefined, isLoading: true, isError: false }],
    ["errored", { data: undefined, isLoading: false, isError: true }],
    ["empty", { data: { rows: [] }, isLoading: false, isError: false }],
  ])("keeps the old Add unit form while the grid is %s (the shell has no Add yet)", (_n, g) => {
    mockGrid = g;
    renderWith({ hideAddForm: true });
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
    expect(screen.getByText(/No other units yet/)).toHaveTextContent(/below/);
  });

  it("the empty state no longer says 'below' when the form is gone", () => {
    loaded(gridRow("pack", "pack"));
    renderWith({ hideAddForm: true });
    expect(screen.getByText(/No other units yet/)).toHaveTextContent(/Add a unit/);
    expect(screen.getByText(/No other units yet/)).not.toHaveTextContent(/below/);
  });

  it("without the prop the form and the row Remove are there, exactly as before", () => {
    mockUnits = [caseUnit];
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit"));
    renderWith({});
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("hides the old Remove on a unit row the shell gives its own Remove (grid kind unit)", () => {
    mockUnits = [caseUnit, palletUnit];
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit"), gridRow("u-pallet", "unit"));
    renderWith({ hideAddForm: true });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("keeps the old Remove on a row the shell has no Remove for, and on every row while the grid is not loaded", () => {
    mockUnits = [caseUnit, palletUnit];
    // the Pallet is the pack row in the grid (no kind unit): only the Case gets the shell's control
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit"));
    const a = renderWith({ hideAddForm: true });
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    a.unmount();
    mockGrid = { data: undefined, isLoading: true, isError: false };
    renderWith({ hideAddForm: true });
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it.each([
    ["a variant", { ...product, parentProductId: "fam-1" }],
    ["a recipe", { ...product, kind: "RECIPE" }],
    ["a family", { ...product, kind: "FAMILY" }],
  ])("%s keeps its old form and its old Remove: the shell mounts neither there", (_n, p) => {
    mockUnits = [caseUnit];
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit"));
    renderWith({ hideAddForm: true }, p);
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("a grid error with cached rows keeps the old Remove (an errored grid is not a mounted shell)", () => {
    mockUnits = [caseUnit];
    mockGrid = {
      data: { rows: [gridRow("pack", "pack"), gridRow("u-case", "unit")] },
      isLoading: false,
      isError: true,
    };
    renderWith({ hideAddForm: true });
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("a unit row the grid marks not editable keeps the old Remove", () => {
    mockUnits = [caseUnit];
    loaded(gridRow("pack", "pack"), gridRow("u-case", "unit", false));
    renderWith({ hideAddForm: true });
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});

describe("K10e F18: changing the default order unit says so and can be undone (inline, no timer)", () => {
  const palletDefault = { ...palletUnit, isDefaultSelling: true };
  const status = () => screen.getByTestId("units-default-note");
  const radios = () => screen.getAllByRole("radio"); // [0] = the pack row, then one per unit
  /** Settle the last write the way the API client does. */
  const succeed = (call = updateMutate.mock.calls.length - 1) =>
    act(() => {
      updateMutate.mock.calls[call][1]?.onSuccess?.({});
    });

  it("the status region is mounted empty, before anything has changed (so it is announced when it fills)", () => {
    mockUnits = [caseUnit];
    renderCard();
    expect(status()).toHaveAttribute("role", "status");
    expect(status()).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a change shows '<Unit> is now the default order unit.' with Undo, only once the write has succeeded", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    expect(status()).toHaveTextContent("");
    succeed();
    expect(status()).toHaveTextContent("Case is now the default order unit.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("Undo makes ONE write that restores the previous default, then announces it and drops Undo", () => {
    mockUnits = [caseUnit, palletDefault];
    renderCard();
    fireEvent.click(radios()[1]); // Case becomes the default; Pallet was
    succeed();
    updateMutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-pallet", isDefaultSelling: true });
    expect(status()).toHaveTextContent("Case is now the default order unit."); // not announced until it is saved
    succeed(0);
    expect(status()).toHaveTextContent("Pallet is the default order unit again.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("when the pack unit was the default, Undo clears the new default with one write and names the pack", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    updateMutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-case", isDefaultSelling: false });
    succeed(0);
    expect(status()).toHaveTextContent("Box is the default order unit again.");
  });

  it("choosing the pack row's radio names the pack, and Undo puts the old unit back", () => {
    mockUnits = [{ ...caseUnit, isDefaultSelling: true }];
    renderCard();
    fireEvent.click(radios()[0]);
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-case", isDefaultSelling: false });
    succeed();
    expect(status()).toHaveTextContent("Box is now the default order unit.");
    updateMutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-case", isDefaultSelling: true });
  });

  it("a failed write shows no status (nothing changed)", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    act(() => {
      updateMutate.mock.calls[0][1]?.onError?.(new Error("nope"));
    });
    expect(status()).toHaveTextContent("");
  });

  it("there is no timer: the status is still there long after 10 seconds", () => {
    jest.useFakeTimers();
    try {
      mockUnits = [caseUnit];
      renderCard();
      fireEvent.click(radios()[1]);
      succeed();
      act(() => {
        jest.advanceTimersByTime(120_000);
      });
      expect(status()).toHaveTextContent("Case is now the default order unit.");
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("Dismiss (a named button) clears it", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(status()).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(updateMutate).toHaveBeenCalledTimes(1); // dismissing writes nothing
  });

  it("Dismiss also clears the 'again' message after an Undo", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    succeed();
    expect(status()).toHaveTextContent("Box is the default order unit again.");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(status()).toHaveTextContent("");
  });

  it("the next unit write clears it: saving a unit's edit", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(status()).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("the next unit write clears it: adding a unit", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: "Pallet" } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    expect(status()).toHaveTextContent("");
  });

  it("the next unit write clears it: removing a unit", async () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    expect(status()).toHaveTextContent("");
  });

  it("the next default change replaces it (Undo then undoes only the latest)", () => {
    mockUnits = [caseUnit, palletUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    fireEvent.click(radios()[2]);
    succeed();
    expect(status()).toHaveTextContent("Pallet is now the default order unit.");
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("a write made elsewhere on the page (another mutation) clears it, so Undo is never stale", () => {
    mockUnits = [caseUnit];
    renderCard();
    fireEvent.click(radios()[1]);
    succeed();
    expect(status()).toHaveTextContent("Case is now the default order unit.");
    act(() => {
      queryClient.getMutationCache().build(queryClient, { mutationFn: async () => 1 });
    });
    expect(status()).toHaveTextContent("");
  });

  describe("keyboard: arrows move focus without saving; Space or Enter commits", () => {
    it("ArrowDown / ArrowUp move focus between the radios and write nothing", async () => {
      mockUnits = [caseUnit, palletUnit];
      renderCard();
      const user = userEvent.setup();
      radios()[1].focus();
      await user.keyboard("{ArrowDown}");
      expect(radios()[2]).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(radios()[1]).toHaveFocus(); // wraps past the end; the pack radio is disabled while it is the default
      expect(updateMutate).not.toHaveBeenCalled();
      expect(radios()[2]).not.toBeChecked();
    });

    it("ArrowUp moves back, still writing nothing", async () => {
      mockUnits = [caseUnit, palletUnit];
      renderCard();
      const user = userEvent.setup();
      radios()[2].focus();
      await user.keyboard("{ArrowUp}");
      expect(radios()[1]).toHaveFocus();
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it("Space on the focused radio commits it", async () => {
      mockUnits = [caseUnit, palletUnit];
      renderCard();
      const user = userEvent.setup();
      radios()[1].focus();
      await user.keyboard("{ArrowDown}");
      await user.keyboard(" ");
      expect(updateMutate).toHaveBeenCalledTimes(1);
      expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-pallet", isDefaultSelling: true });
    });

    it("Enter on the focused radio commits it", async () => {
      mockUnits = [caseUnit, palletUnit];
      renderCard();
      const user = userEvent.setup();
      radios()[2].focus();
      await user.keyboard("{Enter}");
      expect(updateMutate).toHaveBeenCalledTimes(1);
      expect(updateMutate.mock.calls[0][0]).toEqual({ id: "u-pallet", isDefaultSelling: true });
    });

    it("Enter on the radio that is already the default writes nothing", async () => {
      mockUnits = [caseUnit, { ...palletUnit, isDefaultSelling: true }];
      renderCard();
      const user = userEvent.setup();
      radios()[2].focus();
      await user.keyboard("{Enter}");
      expect(updateMutate).not.toHaveBeenCalled();
    });
  });
});
