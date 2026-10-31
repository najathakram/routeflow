import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLinePriceEdit } from "./CounterLinePriceEdit";

/** Row 301: the editor footer buttons must be >= 44px on touch widths (jsdom: class pins only). */
describe("CounterLinePriceEdit: footer tap targets", () => {
  it("Apply and Cancel carry the 44px touch floor", () => {
    render(
      <CounterLinePriceEdit
        canEditPrices
        name="Cola"
        line={{ tierPrice: 10, listPrice: 10, tier: 1, qty: 2, unitWord: "each" }}
        onApply={jest.fn()}
        onClosed={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change price for Cola" }));
    expect(screen.getByRole("button", { name: "Apply" })).toHaveClass("min-h-[44px]");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("min-h-[44px]");
  });
});
