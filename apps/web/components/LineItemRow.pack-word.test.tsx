import * as React from "react";
import { render, screen } from "@testing-library/react";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * Orders r3 Q12 + F15: a boxed line says ONE pack word. The price suffix used to print the product's
 * stored unit ("$18.00 / case") beside a "Box" toggle and a "box" quantity. All three now come from the
 * line's own pack word (default Box; a tenant word such as Carton flows through). A line sold by a named
 * unit, or a plain single-unit line, keeps its own unit word in the suffix.
 */
const item = (over: Partial<LineItemRowItem> = {}): LineItemRowItem =>
  ({
    tempId: "a",
    productId: "p1",
    productName: "Corn Chips",
    unit: "case",
    listPrice: 18,
    unitPrice: 18,
    priceType: "STANDARD",
    qty: 24,
    unitsPerBox: 12,
    boxes: 2,
    pieces: 0,
    ...over,
  }) as LineItemRowItem;

const noop = jest.fn();
const renderRow = (over: Partial<LineItemRowItem> = {}) =>
  render(
    <ul>
      <LineItemRow
        {...({
          item: item(over),
          marginFloor: 0,
          floorAcked: false,
          costRevealed: false,
          onQtyDelta: noop,
          onSetBoxes: noop,
          onSetPieces: noop,
          onSetUnitQty: noop,
          onSetSellBy: noop,
          onSetDiscountedPrice: noop,
          onSetToFloor: noop,
          onAckFloor: noop,
          onToggleCostRevealed: noop,
          onToggleNoteOpen: noop,
          onSetNote: noop,
          onUpdateUnlistedName: noop,
          onUpdateUnlistedPrice: noop,
          onRemove: noop,
          onSetQty: noop,
        } as LineItemRowProps)}
      />
    </ul>,
  );

describe("LineItemRow: one pack word on a boxed line", () => {
  it("default words: the toggle, the price suffix and the quantity all say box, never case", () => {
    const { container } = renderRow();
    expect(screen.getByRole("button", { name: "Box" })).toBeInTheDocument();
    expect(screen.getByText("$18.00 / box")).toBeInTheDocument();
    expect(screen.getByTestId("line-qty-cases-row")).toHaveTextContent("box");
    expect(container).not.toHaveTextContent(/case/i);
  });

  it.each([
    ["SPECIAL", { priceType: "SPECIAL" as const, listPrice: 20 }],
    ["DISCOUNTED", { priceType: "DISCOUNTED" as const, listPrice: 20 }],
    ["MANUAL", { priceType: "MANUAL" as const, listPrice: 15 }],
  ])("a %s price keeps the same pack word in its suffix", (_name, over) => {
    const { container } = renderRow(over);
    expect(screen.getByText("$18.00 / box")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/case/i);
  });

  it("a tenant pack word flows through the toggle, the suffix and the quantity", () => {
    const { container } = renderRow({ packLabel: "Carton" });
    expect(screen.getByRole("button", { name: "Carton" })).toBeInTheDocument();
    expect(screen.getByText("$18.00 / carton")).toBeInTheDocument();
    expect(screen.getByTestId("line-qty-cases-row")).toHaveTextContent("carton");
    expect(container).not.toHaveTextContent(/\bcase\b|\bbox\b/i);
  });

  it("a line sold by a named unit keeps that unit in the suffix (no pack word)", () => {
    renderRow({
      unit: "Bag",
      unitLabel: "Bag",
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
    });
    expect(screen.getByText("$18.00 / Bag")).toBeInTheDocument();
  });

  it("a plain single-unit line keeps the product's own unit in the suffix", () => {
    renderRow({ unit: "each", unitsPerBox: undefined, boxes: undefined, pieces: undefined });
    expect(screen.getByText("$18.00 / each")).toBeInTheDocument();
  });
});
