import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { RecurringInvoiceForm } from "./RecurringInvoiceForm";

/**
 * W-686 (row 446's third copy): the recurring-invoice line search closes its popup on Tab and when focus leaves for
 * anywhere outside its own list, so it never sits over the next field. Focus moving INTO the list keeps it open, and a
 * press inside the list does not steal focus from the input (a click must still land).
 */

const MINT = {
  id: "p-mint",
  name: "Mint Pod",
  kind: "PRODUCT",
  parentProductId: null,
  unit: "each",
  pricePerUnit: 4,
  isActive: true,
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [MINT] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [] } }),
}));

function openPopup() {
  renderWithProviders(
    <RecurringInvoiceForm
      mode="create"
      onSubmit={jest.fn()}
      isPending={false}
      submitLabel="Save"
    />,
  );
  const input = screen.getByPlaceholderText("Description / product…") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "mint" } });
  return input;
}

describe("recurring invoice line search closes on Tab and blur (W-686)", () => {
  it("Tab closes the popup", async () => {
    const input = openPopup();
    await screen.findByRole("button", { name: /Mint Pod/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("button", { name: /Mint Pod/ })).not.toBeInTheDocument();
  });

  it("blur to an element outside the list closes the popup", async () => {
    const input = openPopup();
    await screen.findByRole("button", { name: /Mint Pod/ });
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByRole("button", { name: /Mint Pod/ })).not.toBeInTheDocument();
  });

  it("focus moving into the popup's own list keeps it open", async () => {
    const input = openPopup();
    const option = await screen.findByRole("button", { name: /Mint Pod/ });
    fireEvent.blur(input, { relatedTarget: option });
    expect(screen.getByRole("button", { name: /Mint Pod/ })).toBeInTheDocument();
  });

  it("a press inside the list does not take focus from the input", async () => {
    openPopup();
    const option = await screen.findByRole("button", { name: /Mint Pod/ });
    const notPrevented = fireEvent.mouseDown(option); // false when the handler called preventDefault
    expect(notPrevented).toBe(false);
  });
});
