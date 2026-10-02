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

  // #2305: the order-edit price row sets only `unitPrice` (priceType stays STANDARD). Master
  // re-checked on every price change and snapped the typed price back to the ladder's.
  it("keeps a price-only edit on a unit line: no refresh when only unitPrice moves (#2305)", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <OrderLineUnitPicker line={caseLine} tier={1} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled(); // 480 is already the ladder's Case price
    rerender(
      <OrderLineUnitPicker line={{ ...caseLine, unitPrice: 500 }} tier={1} onChange={onChange} />,
    );
    rerender(
      <OrderLineUnitPicker line={{ ...caseLine, unitPrice: 505 }} tier={1} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still re-prices a hand-priced STANDARD unit line when the tier then changes under it (#2305)", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <OrderLineUnitPicker line={{ ...caseLine, unitPrice: 500 }} tier={1} onChange={onChange} />,
    );
    // first sight at a price that is not the ladder's: the mount refresh (pinned above) applies
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    rerender(
      <OrderLineUnitPicker line={{ ...caseLine, unitPrice: 500 }} tier={1} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled(); // same ladder, same typed price: nothing
    rerender(
      <OrderLineUnitPicker line={{ ...caseLine, unitPrice: 500 }} tier={2} onChange={onChange} />,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Case", price: 240 }),
      true,
    );
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

  // #2381: "Not available" → Undo unmounts and remounts the picker, and the first-sight refresh
  // snapped a price the operator had TYPED back to the ladder's. A typed price survives a remount.
  describe("a typed price survives a remount (#2381)", () => {
    const typed = { ...caseLine, unitPrice: 300, priceEdited: true };

    it("first sight after a remount does not re-price a line whose price was typed", () => {
      const onChange = jest.fn();
      const first = render(<OrderLineUnitPicker line={typed} tier={2} onChange={onChange} />);
      first.unmount(); // "Not available"
      render(<OrderLineUnitPicker line={typed} tier={2} onChange={onChange} />); // Undo
      expect(onChange).not.toHaveBeenCalled();
    });

    it("nor when the ladder loads after the picker mounted", () => {
      const onChange = jest.fn();
      mockUnits = undefined;
      const view = render(<OrderLineUnitPicker line={typed} tier={2} onChange={onChange} />);
      mockUnits = [CASE];
      view.rerender(<OrderLineUnitPicker line={typed} tier={2} onChange={onChange} />);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("a real ladder move afterwards (the customer's tier changes) still re-prices it", () => {
      const onChange = jest.fn();
      const view = render(<OrderLineUnitPicker line={typed} tier={1} onChange={onChange} />);
      expect(onChange).not.toHaveBeenCalled();
      view.rerender(<OrderLineUnitPicker line={typed} tier={2} onChange={onChange} />);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ value: "Case", price: 240 }),
        true,
      );
    });

    it("an untyped line is still refreshed on first sight (unchanged)", () => {
      const onChange = jest.fn();
      render(<OrderLineUnitPicker line={caseLine} tier={2} onChange={onChange} />);
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ price: 240 }), true);
    });
  });
});

describe("OrderLineUnitPicker: a NEW line starts on the default selling unit (#2784)", () => {
  const FLAGGED: ProductUnitLevel = { ...CASE, isDefaultSelling: true };
  const renderPicker = (line: OrderLineUnitPickerLine, extra: Record<string, unknown> = {}) => {
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={line} tier={1} onChange={onChange} {...extra} />);
    return onChange;
  };

  it("with startOnDefaultUnit, a fresh pack line whose ladder flags Case is moved to Case once", () => {
    mockUnits = [FLAGGED];
    const onChange = renderPicker(packLine, { startOnDefaultUnit: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ value: "Case", factorToBase: 288 });
    expect(onChange.mock.calls[0][1]).toBe(false);
  });

  it("does nothing without the prop (every other row keeps today's behaviour)", () => {
    mockUnits = [FLAGGED];
    expect(renderPicker(packLine)).not.toHaveBeenCalled();
  });

  it("does nothing when no level is flagged, the ladder is empty, or units_v1 is off", () => {
    mockUnits = [CASE];
    expect(renderPicker(packLine, { startOnDefaultUnit: true })).not.toHaveBeenCalled();
    mockUnits = [];
    expect(renderPicker(packLine, { startOnDefaultUnit: true })).not.toHaveBeenCalled();
    mockUnits = [FLAGGED];
    mockEnabled = false;
    expect(renderPicker(packLine, { startOnDefaultUnit: true })).not.toHaveBeenCalled();
  });

  it("never overrides a unit the line already holds, or a price the operator typed", () => {
    mockUnits = [FLAGGED];
    expect(renderPicker(caseLine, { startOnDefaultUnit: true })).not.toHaveBeenCalled();
    expect(
      renderPicker({ ...packLine, priceEdited: true }, { startOnDefaultUnit: true }),
    ).not.toHaveBeenCalled();
  });

  it("Opus #2865 B1/r2: never re-units a line whose price the OPERATOR typed", () => {
    mockUnits = [FLAGGED];
    expect(
      renderPicker({ ...packLine, priceEdited: true }, { startOnDefaultUnit: true }),
    ).not.toHaveBeenCalled();
  });

  it("SA-626d: a price the SYSTEM pre-filled from history (discounted / manual) is not a shape: the line still starts on the default unit", () => {
    mockUnits = [FLAGGED];
    const start = { startOnDefaultUnit: true };
    expect(
      renderPicker({ ...packLine, discountedPrice: 40, priceType: "DISCOUNTED" }, start),
    ).toHaveBeenCalledTimes(1);
    expect(
      renderPicker({ ...packLine, discountedPrice: 60, priceType: "MANUAL" }, start),
    ).toHaveBeenCalledTimes(1);
  });

  it("Opus #2865 r2: a realistic BOXED new line (24/box, qty = 24 pieces = 1 box) DOES start on the default: qty is total pieces, never a guard", () => {
    mockUnits = [FLAGGED];
    const onChange = renderPicker(
      { ...packLine, unitsPerBox: 24, qty: 24 },
      { startOnDefaultUnit: true },
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ value: "Case" });
  });

  it("Opus #2865 B1: once the modal consumed the flag (prop false, as after any unit choice) a REMOUNT never re-applies it", () => {
    mockUnits = [FLAGGED];
    const first = renderPicker(packLine, { startOnDefaultUnit: true });
    expect(first).toHaveBeenCalledTimes(1);
    // the screen switch remounts the picker; the line's flag was cleared by setLineUnit
    expect(renderPicker(packLine, { startOnDefaultUnit: false })).not.toHaveBeenCalled();
  });
});
