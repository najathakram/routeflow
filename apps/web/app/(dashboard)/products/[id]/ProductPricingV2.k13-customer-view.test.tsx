import { render, screen } from "@testing-library/react";
import { CustomerViewSlot } from "./ProductPricingV2";

let editingIn: "inline" | "window" | null = null;

jest.mock("./units-v2/edit/usePriceDraft", () => ({
  usePriceDraft: () => ({ editingIn }),
}));
jest.mock("./units-v2/customer/CustomerPriceView", () => ({
  CustomerPriceView: () => <section data-testid="customer-view">Customer view</section>,
}));

// K13 (owner ruling D-2026-10-19): the Customer view steps aside while the INLINE editor is open and
// returns on Save or Cancel. The jump strip builds itself from the DOM, so its entry goes with the section.
describe("K13: the Customer view steps aside while prices are edited inline", () => {
  it("shows the Customer view when nothing is being edited", () => {
    editingIn = null;
    render(<CustomerViewSlot productId="p1" />);
    expect(screen.getByTestId("customer-view")).toBeInTheDocument();
  });
  it("hides it while the inline editor is open", () => {
    editingIn = "inline";
    render(<CustomerViewSlot productId="p1" />);
    expect(screen.queryByTestId("customer-view")).not.toBeInTheDocument();
  });
  it("keeps it when the floating window is the editor", () => {
    editingIn = "window";
    render(<CustomerViewSlot productId="p1" />);
    expect(screen.getByTestId("customer-view")).toBeInTheDocument();
  });
});
