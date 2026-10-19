import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { PriceDraftContext, type PriceDraft } from "../edit/usePriceDraft";
import { UnitsBesideGrid } from "./UnitsBesideGrid";

const updateMutate = jest.fn();
let mockUnits: unknown[] = [];
jest.mock("@/lib/api/product-units", () => ({
  useProductUnits: () => ({ data: mockUnits, isLoading: false, isError: false }),
  useUpdateProductUnit: () => ({ mutate: updateMutate, isPending: false }),
}));

const mk = (id: string, label: string, factorToBase: number, isDefaultSelling = false) => ({
  id,
  label,
  factorToBase,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling,
  sortOrder: 0,
});
const product = { id: "p1", unit: "Box" };

let draft: { dirty: boolean; editingIn: "inline" | "window" | null };
function renderBeside() {
  const d = { ...draft, editing: draft.editingIn !== null } as unknown as PriceDraft;
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <PriceDraftContext.Provider value={d}>
          <UnitsBesideGrid product={product} />
        </PriceDraftContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  mockUnits = [
    mk("u-case", "Case", 24),
    mk("u-pallet", "Pallet", 480, true),
    mk("u-pc", "Piece", 1),
  ];
  draft = { dirty: false, editingIn: null };
});

describe("UnitsBesideGrid: default order unit", () => {
  it("is a labelled select in view mode listing the pack and every unit, with the default chosen", () => {
    renderBeside();
    const sel = screen.getByLabelText("Default order unit") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Box", "Case", "Pallet", "Piece"]);
    expect(sel.value).toBe("u-pallet");
    expect(sel).toBeEnabled();
  });

  it("changing it writes through the shared hook; choosing the pack unsets the default", () => {
    renderBeside();
    const sel = screen.getByLabelText("Default order unit");
    fireEvent.change(sel, { target: { value: "u-case" } });
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-case", isDefaultSelling: true },
      expect.any(Object),
    );
    fireEvent.change(sel, { target: { value: "" } });
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-pallet", isDefaultSelling: false },
      expect.any(Object),
    );
  });

  it("is disabled with the reason while the price draft is dirty", () => {
    draft = { dirty: true, editingIn: "inline" };
    renderBeside();
    const sel = screen.getByLabelText("Default order unit");
    expect(sel).toBeDisabled();
    expect(sel).toHaveAccessibleDescription("Save or discard your price changes first");
  });
});

describe("UnitsBesideGrid: name and contains", () => {
  it("shows no name or contains fields outside edit mode", () => {
    renderBeside();
    expect(screen.queryByLabelText("Case name")).toBeNull();
    expect(screen.queryByLabelText("Pieces per Case")).toBeNull();
  });

  it("in edit mode edits every unit but the smallest, and Save sends name + contains only", () => {
    draft = { dirty: false, editingIn: "inline" };
    renderBeside();
    expect(screen.queryByLabelText("Piece name")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull(); // untouched row: no Save
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: " Carton " } });
    fireEvent.change(screen.getByLabelText("Pieces per Case"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Case" }));
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-case", label: "Carton", factorToBase: 12 },
      expect.any(Object),
    );
  });

  it("refuses an empty name or a blank contains (Save disabled) and Cancel restores", () => {
    draft = { dirty: false, editingIn: "inline" };
    renderBeside();
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save Case" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "Case" } });
    fireEvent.change(screen.getByLabelText("Pieces per Case"), { target: { value: "" } }); // blank: no size
    expect(screen.getByRole("button", { name: "Save Case" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Case" }));
    expect(screen.getByLabelText("Pieces per Case")).toHaveValue("24");
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("is disabled with the reason while the price draft is dirty", () => {
    draft = { dirty: true, editingIn: "inline" };
    renderBeside();
    expect(screen.getByLabelText("Case name")).toBeDisabled();
    expect(screen.getByLabelText("Pieces per Case")).toBeDisabled();
    expect(screen.getByLabelText("Case name")).toHaveAccessibleDescription(
      "Save or discard your price changes first",
    );
  });
});
