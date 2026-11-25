import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * UX audit 2026-11-24 F32: Create Order took 60.00 on a $6.00 line with no words. The order page's price edit says
 * "900% above list ($6.00)"; the Create Order line now says the same sentence, from the same helper.
 */
const line = (over: Partial<LineItemRowItem>): LineItemRowItem => ({
  tempId: "t1",
  productId: "p1",
  productName: "Sample Chips",
  unit: "each",
  listPrice: 6,
  unitPrice: 6,
  priceType: "STANDARD",
  qty: 1,
  ...over,
});

function props(item: LineItemRowItem): LineItemRowProps {
  return {
    item,
    marginFloor: 0,
    floorAcked: false,
    costRevealed: false,
    onQtyDelta: jest.fn(),
    onSetBoxes: jest.fn(),
    onSetPieces: jest.fn(),
    onSetUnitQty: jest.fn(),
    onSetSellBy: jest.fn(),
    onSetDiscountedPrice: jest.fn(),
    onSetToFloor: jest.fn(),
    onAckFloor: jest.fn(),
    onToggleCostRevealed: jest.fn(),
    onToggleNoteOpen: jest.fn(),
    onSetNote: jest.fn(),
    onUpdateUnlistedName: jest.fn(),
    onUpdateUnlistedPrice: jest.fn(),
    onRemove: jest.fn(),
  };
}
const show = (over: Partial<LineItemRowItem>) =>
  renderWithProviders(<LineItemRow {...props(line(over))} />);
const note = () => screen.queryByTestId("line-price-far-from-list");

describe("Create Order line: a price far from list says so (F32)", () => {
  it("60.00 typed on a $6.00 line reads 900% above list ($6.00)", () => {
    show({ unitPrice: 60, discountedPrice: 60, priceType: "MANUAL" });
    expect(note()).toHaveTextContent("900% above list ($6.00)");
  });

  it("0.60 typed on a $6.00 line reads 90% below list ($6.00)", () => {
    show({ unitPrice: 0.6, discountedPrice: 0.6, priceType: "DISCOUNTED" });
    expect(note()).toHaveTextContent("90% below list ($6.00)");
  });

  it("the list price itself, and an ordinary discount or upsell, say nothing", () => {
    show({});
    expect(note()).toBeNull();
    show({ tempId: "t2", unitPrice: 5, discountedPrice: 5, priceType: "DISCOUNTED" });
    show({ tempId: "t3", unitPrice: 7.5, discountedPrice: 7.5, priceType: "MANUAL" });
    expect(note()).toBeNull();
  });

  it("a customer's special price far below list is not called a slip", () => {
    show({ unitPrice: 2, specialPrice: 2, priceType: "SPECIAL" });
    expect(note()).toBeNull();
  });

  it("a line with no list price (typed in by hand) says nothing", () => {
    show({ productId: "", isUnlisted: true, listPrice: 0, unitPrice: 40, priceType: "MANUAL" });
    expect(note()).toBeNull();
  });
});
