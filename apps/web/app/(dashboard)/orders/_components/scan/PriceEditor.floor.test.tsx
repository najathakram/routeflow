import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { priceForMarginFloor } from "@routeflow/pricing";
import { renderWithProviders } from "@/test-utils/render";
import type { LineItemRowItem } from "@/components/LineItemRow";
import { PriceEditor, type PriceEditorProps } from "./PriceEditor";

// Unlike PriceEditor.test.tsx this renders the REAL MarginHint (no mock), so the margin floor is
// proven end to end through the sheet: a below-cost / below-floor price surfaces the warning and the
// one-tap fix, and a case price is judged against a CASE cost.

const caseLine = (o: Partial<LineItemRowItem> = {}): LineItemRowItem => ({
  tempId: "t1",
  productId: "p1",
  productName: "Case Soda",
  unit: "case",
  listPrice: 12,
  unitPrice: 12,
  priceType: "STANDARD",
  qty: 12,
  unitsPerBox: 6,
  boxes: 2,
  pieces: 0,
  unitCost: 1, // per PIECE: a case costs 6.00
  ...o,
});

function setup(li: LineItemRowItem, over: Partial<PriceEditorProps> = {}) {
  const props: PriceEditorProps = {
    line: li,
    marginFloor: 0.15,
    floorAcked: false,
    costRevealed: true,
    onQtyDelta: jest.fn(),
    onSetBoxes: jest.fn(),
    onSetPieces: jest.fn(),
    onSetUnitQty: jest.fn(),
    onSetSellBy: jest.fn(),
    onSetDiscountedPrice: jest.fn(),
    onSetToFloor: jest.fn(),
    onAckFloor: jest.fn(),
    onToggleCostRevealed: jest.fn(),
    onClose: jest.fn(),
    ...over,
  };
  renderWithProviders(<PriceEditor {...props} />);
  return props;
}

describe("PriceEditor - the real margin floor", () => {
  it("a case price BELOW the case cost shows the warning and 'Set to floor' at the right price", () => {
    // 4.00 per case vs a 6.00 case cost -> below cost. Judged per PIECE (1.00) it would look fine.
    const props = setup(caseLine({ unitPrice: 4 }));
    const floorPrice = priceForMarginFloor(1, 0.15, 6);
    fireEvent.click(screen.getByRole("button", { name: `Set to floor $${floorPrice.toFixed(2)}` }));
    expect(props.onSetToFloor).toHaveBeenCalledWith(floorPrice);
    expect(floorPrice).toBeGreaterThan(6); // a CASE floor, not a piece floor
  });

  it("'Sell anyway' acknowledges through the row's own handler", () => {
    const props = setup(caseLine({ unitPrice: 4 }));
    fireEvent.click(screen.getByRole("button", { name: /sell anyway/i }));
    expect(props.onAckFloor).toHaveBeenCalledTimes(1);
  });

  it("an acknowledged below-floor price no longer offers the actions (same as the row)", () => {
    setup(caseLine({ unitPrice: 4 }), { floorAcked: true });
    expect(screen.queryByRole("button", { name: /set to floor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sell anyway/i })).not.toBeInTheDocument();
  });

  it("a healthy case price shows no warning actions", () => {
    setup(caseLine({ unitPrice: 12 }));
    expect(screen.queryByRole("button", { name: /set to floor/i })).not.toBeInTheDocument();
  });

  it("the warning still renders with the cost concealed - the floor is a selling price, not raw cost", () => {
    setup(caseLine({ unitPrice: 4 }), { costRevealed: false });
    expect(screen.getByRole("button", { name: /set to floor/i })).toBeInTheDocument();
  });
});
