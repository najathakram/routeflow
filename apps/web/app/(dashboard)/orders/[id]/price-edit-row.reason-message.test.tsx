import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PriceEditRow } from "./price-edit-row";

/**
 * Row 329b: a special-price line whose price changed in this edit needs a reason (the server refuses the save without a
 * non-blank one). The box used to turn red with no words; it now says what is wrong, in a message the input is described by.
 */
function Harness({ price = 9, isSpecial = true }: { price?: number; isSpecial?: boolean }) {
  const [reason, setReason] = React.useState("");
  return (
    <PriceEditRow
      basePrice={12}
      unitPrice={price}
      originalUnitPrice={10}
      overrideReason={reason}
      onPriceChange={() => {}}
      onReasonChange={setReason}
      isSpecial={isSpecial}
    />
  );
}
const reasonBox = () => screen.getByPlaceholderText("reason (required)");

describe("PriceEditRow: the required-reason message", () => {
  it("a changed special price with no reason says what is wrong, in words", () => {
    renderWithProviders(<Harness />);
    const message = screen.getByText("Add a reason to change this customer's special price.");
    expect(message).toBeVisible();
    expect(reasonBox()).toHaveAttribute("aria-invalid", "true");
    expect(reasonBox()).toHaveAccessibleDescription(
      "Add a reason to change this customer's special price.",
    );
  });

  it("typing a reason clears the message and the invalid state; a blank one keeps them", async () => {
    renderWithProviders(<Harness />);
    await userEvent.type(reasonBox(), "   ");
    expect(screen.getByText(/Add a reason to change/)).toBeInTheDocument();
    await userEvent.type(reasonBox(), "Damaged box");
    expect(screen.queryByText(/Add a reason to change/)).toBeNull();
    expect(reasonBox()).not.toHaveAttribute("aria-invalid");
  });

  it("an untouched special line, and a plain line's optional reason, show no message", () => {
    const { unmount } = renderWithProviders(<Harness price={10} />);
    expect(screen.queryByText(/Add a reason to change/)).toBeNull();
    unmount();
    renderWithProviders(<Harness isSpecial={false} />);
    expect(screen.queryByText(/Add a reason to change/)).toBeNull();
    expect(screen.getByPlaceholderText("reason (optional)")).not.toHaveAttribute("aria-invalid");
  });
});
