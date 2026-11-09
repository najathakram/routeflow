import * as React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * W-1170 F12b (P25): the pack size is asked in ONE place on New product, the Units per box field. The parsed
 * suggestion is helper text under that field ("Looks like 24 per box. Use 24"), never a second question card.
 * Never-guess rules stay: HIGH/MEDIUM offer the count, AMBIGUOUS states the conflict and offers nothing,
 * PIECE_UNIT shows nothing.
 */
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

function fill(name: string, unit: string) {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/^Unit \*/), { target: { value: unit } });
}
const perBoxInputs = () => screen.queryAllByLabelText(/per box$/i);

describe("W-1170 F12b: pack size asked once", () => {
  it("HIGH: one input asks the pack size; the suggestion is helper text with Use 24", () => {
    fill("UX Cola 24PK", "case");
    expect(perBoxInputs()).toHaveLength(1);
    expect(screen.queryByText(/How many .* in a box\?/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set pack size" })).toBeNull();
    expect(screen.getByText(/Looks like 24 per box\./)).toBeInTheDocument();
    // Never written until the operator accepts.
    expect(screen.getByLabelText("Units per box")).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Use 24" }));
    expect(screen.getByLabelText("Units per box")).toHaveValue(24);
    // The Use button disappears; focus must land on the field, not be lost to the page.
    expect(screen.getByLabelText("Units per box")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Use 24" })).toBeNull();
  });

  it("AMBIGUOUS: states the conflict, offers no count, leaves the field empty", () => {
    fill("UX Shot 5CT - 12Pack", "case");
    expect(perBoxInputs()).toHaveLength(1);
    expect(screen.getByText(/mentions 2 different counts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Use \d+$/ })).toBeNull();
    expect(screen.getByLabelText("Units per box")).toHaveValue(null);
  });

  it("PIECE_UNIT: nothing is suggested", () => {
    fill("UX Widget 12CT", "each");
    expect(screen.queryByText(/Looks like|different counts/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use \d+$/ })).toBeNull();
  });

  it("the suggestion is linked to the field (aria-describedby) so it is read with it", () => {
    fill("UX Cola 24PK", "case");
    const help = screen.getByText(/Looks like 24 per box./);
    expect(screen.getByLabelText("Units per box").getAttribute("aria-describedby")).toContain(
      help.id,
    );
  });

  it("a typed Units per box is the pack size Create sends", async () => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ id: "p1", name: "UX Cola", unit: "case", pricePerUnit: "5" });
    fill("UX Cola", "case");
    fireEvent.change(screen.getByLabelText(/^Price per/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Units per box"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].unitsPerBox).toBe(12);
  });
});
