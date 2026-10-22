import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PriceEditRow } from "./price-edit-row";

jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

// F14: a price far from the line's list price gets a muted amber hint. Display only: nothing blocks.
const row = (unitPrice: number, basePrice = 6.99) =>
  renderWithProviders(
    <PriceEditRow
      basePrice={basePrice}
      unitPrice={unitPrice}
      originalUnitPrice={basePrice}
      onPriceChange={jest.fn()}
      onReasonChange={jest.fn()}
    />,
  );

describe("PriceEditRow far-from-list hint (F14)", () => {
  it("3.00 on a $6.99 line says 57% below list ($6.99)", () => {
    row(3);
    expect(screen.getByTestId("price-far-from-list")).toHaveTextContent("57% below list ($6.99)");
  });
  it("more than double the list price says above list", () => {
    row(15);
    expect(screen.getByTestId("price-far-from-list")).toHaveTextContent("115% above list ($6.99)");
  });
  it("an ordinary discount shows no hint, and neither does the list price", () => {
    row(5.99);
    expect(screen.queryByTestId("price-far-from-list")).toBeNull();
  });
  it("no list price, no hint; the hint never disables or blocks the price field", () => {
    row(3, 0);
    expect(screen.queryByTestId("price-far-from-list")).toBeNull();
    row(3);
    expect(screen.getAllByRole("textbox")[0]).toBeEnabled();
  });
});
