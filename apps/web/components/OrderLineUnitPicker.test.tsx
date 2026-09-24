import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProductUnitLevel } from "@routeflow/types";
import { OrderLineUnitPicker, type OrderLineUnitPickerLine } from "./OrderLineUnitPicker";

let mockEnabled = true;
let mockUnits: ProductUnitLevel[] | undefined = [];
const useProductUnits = jest.fn();
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockEnabled,
  useProductUnits: (...a: unknown[]) => {
    useProductUnits(...a);
    return { data: mockUnits };
  },
}));

const CASE: ProductUnitLevel = {
  id: "u1",
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

const packLine: OrderLineUnitPickerLine = {
  productId: "p1",
  productName: "Widget",
  unit: "Box",
  unitsPerBox: 24,
  listPrice: 42,
  unitPrice: 42,
  priceType: "STANDARD",
  tierPrices: { pricePerUnit: "42.00", priceTier2: "21.00" },
};
const caseLine: OrderLineUnitPickerLine = {
  ...packLine,
  unit: "Case",
  unitsPerBox: undefined,
  unitLabel: "Case",
  unitPrice: 480,
  packBase: {
    unit: "Box",
    qty: 24,
    unitsPerBox: 24,
    listPrice: 42,
    unitPrice: 42,
    priceType: "STANDARD",
  },
};

beforeEach(() => {
  mockEnabled = true;
  mockUnits = [CASE];
  useProductUnits.mockClear();
});

describe("OrderLineUnitPicker", () => {
  it("renders nothing — and asks for no ladder — when the tenant lacks flag.units_v1", () => {
    mockEnabled = false;
    mockUnits = undefined;
    const { container } = render(
      <OrderLineUnitPicker line={packLine} tier={1} onChange={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(useProductUnits).toHaveBeenCalledWith("p1", false);
  });

  it("renders nothing for a product with no levels, and never asks for an unlisted line's ladder", () => {
    mockUnits = [];
    const { container } = render(
      <OrderLineUnitPicker line={packLine} tier={1} onChange={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    render(
      <OrderLineUnitPicker
        line={{ ...packLine, productId: "", isUnlisted: true }}
        tier={1}
        onChange={jest.fn()}
      />,
    );
    expect(useProductUnits).toHaveBeenLastCalledWith("", false);
  });

  it("offers the pack, Case and Piece, named for the product, priced at the pack line's own price", () => {
    render(
      <OrderLineUnitPicker line={{ ...packLine, unitPrice: 38 }} tier={1} onChange={jest.fn()} />,
    );
    const select = screen.getByLabelText("Sell Widget by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "Box · 24 pcs · $38.00", // the parent's pack price (a remembered discount), not the list price
      "Case · 288 pcs · $480.00",
      "Piece · $1.75",
    ]);
  });

  it("reports the chosen option as a real switch, and the pack as the empty unit", () => {
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={packLine} tier={1} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Sell Widget by"), { target: { value: "Case" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "Case", price: 480 }),
      false,
    );
  });

  it("re-prices a unit line when the customer's tier changed under it, keeping the typed count", () => {
    const onChange = jest.fn();
    // the line still carries the tier-1 Case price; tier 2 makes the ladder price 240
    render(<OrderLineUnitPicker line={caseLine} tier={2} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Case", price: 240 }),
      true,
    );
  });

  it("does not touch a unit line whose price is already the ladder's, or one the operator priced by hand", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <OrderLineUnitPicker line={caseLine} tier={1} onChange={onChange} />,
    );
    rerender(
      <OrderLineUnitPicker
        line={{ ...caseLine, unitPrice: 400, priceType: "DISCOUNTED" }}
        tier={2}
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets a held unit to the pack even when the product's ladder is now EMPTY (review defect 3)", () => {
    mockUnits = [];
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={caseLine} tier={1} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: "", kind: "pack", label: "Box", factorToBase: 24 }),
      false,
    );
  });

  it("resets a held unit the product no longer has back to the pack instead of masking it", () => {
    const onChange = jest.fn();
    render(
      <OrderLineUnitPicker
        line={{ ...caseLine, unitLabel: "Pallet" }}
        tier={1}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: "", kind: "pack" }),
      false,
    );
  });
});
