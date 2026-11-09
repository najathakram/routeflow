import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * W-1170 F12b (P25): the pack size is asked in ONE place on New product, the Units per box field. The parsed
 * suggestion is helper text under that field ("Looks like 24 per box. Use 24"), never a second question card.
 * Never-guess rules stay: HIGH/MEDIUM offer the count, AMBIGUOUS states the conflict and offers nothing,
 * PIECE_UNIT shows nothing.
 */
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

  it("a typed Units per box is sent with Create (the field is the only answer)", () => {
    fill("UX Cola", "case");
    fireEvent.change(screen.getByLabelText("Units per box"), { target: { value: "12" } });
    expect(screen.getByLabelText("Units per box")).toHaveValue(12);
  });
});
