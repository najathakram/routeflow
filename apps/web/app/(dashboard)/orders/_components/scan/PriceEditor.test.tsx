import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { computeLineSubtotal } from "@routeflow/pricing";
import type { LineItemRowItem } from "@/components/LineItemRow";
import { PriceEditor, type PriceEditorProps } from "./PriceEditor";

// MarginHint is the SAME component the row renders; stubbing it lets these tests assert it is wired
// with the row's exact props (so the floor check cannot be bypassed by the sheet) without its
// query hooks.
let marginHintProps: Record<string, any> = {};
jest.mock("@/components/MarginHint", () => ({
  MarginHint: (props: Record<string, any>) => {
    marginHintProps = props;
    return <div data-testid="margin-hint" />;
  },
}));

const line = (o: Partial<LineItemRowItem> = {}): LineItemRowItem => ({
  tempId: "t1",
  productId: "p1",
  productName: "Widget",
  unit: "each",
  listPrice: 10,
  unitPrice: 10,
  priceType: "STANDARD",
  qty: 2,
  unitCost: 6,
  ...o,
});

const boxed = (o: Partial<LineItemRowItem> = {}) =>
  line({
    productName: "Case Soda",
    unit: "case",
    listPrice: 24,
    unitPrice: 24,
    unitsPerBox: 6,
    boxes: 2,
    pieces: 0,
    qty: 12,
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
  render(<PriceEditor {...props} />);
  return props;
}

describe("PriceEditor", () => {
  beforeEach(() => {
    marginHintProps = {};
  });

  it("is a labelled dialog for the line, showing its list price", () => {
    setup(line());
    expect(screen.getByRole("dialog", { name: "Edit Widget" })).toBeInTheDocument();
    expect(screen.getByText("List $10.00 / each")).toBeInTheDocument();
  });

  describe("price", () => {
    it("writes through the row's own setDiscountedPrice handler", () => {
      const props = setup(line());
      fireEvent.change(screen.getByLabelText("Price"), { target: { value: "8.50" } });
      expect(props.onSetDiscountedPrice).toHaveBeenLastCalledWith(8.5);
    });

    it("clearing the field clears the one-time price (null), not zero", () => {
      const props = setup(line({ discountedPrice: 8.5 }));
      fireEvent.change(screen.getByLabelText("Price"), { target: { value: "" } });
      expect(props.onSetDiscountedPrice).toHaveBeenLastCalledWith(null);
    });

    it("labels a case-packed line's price as the CASE price", () => {
      setup(boxed());
      expect(screen.getByText("Case price")).toBeInTheDocument();
    });

    it("shows the customer's last price when it differs from list", () => {
      setup(line(), { priceHistoryEntry: { lastPrice: 9.25 } });
      expect(screen.getByText("Last: $9.25")).toBeInTheDocument();
    });

    it("hides the 'Last' hint when it equals list", () => {
      setup(line(), { priceHistoryEntry: { lastPrice: 10 } });
      expect(screen.queryByText(/Last:/)).not.toBeInTheDocument();
    });

    it("a SPECIAL (customer-permanent) price is shown, never overridden, exactly as in the row", () => {
      setup(line({ priceType: "SPECIAL", unitPrice: 7.5 }));
      expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();
      expect(screen.getByText(/Special price \$7\.50/)).toBeInTheDocument();
    });
  });

  describe("quantity — a plain line", () => {
    it("steps with the row's onQtyDelta and cannot go below 1", () => {
      const props = setup(line({ qty: 1 }));
      expect(screen.getByLabelText("One fewer")).toBeDisabled();
      fireEvent.click(screen.getByLabelText("One more"));
      expect(props.onQtyDelta).toHaveBeenCalledWith(1);
    });

    it("decrements when above 1", () => {
      const props = setup(line({ qty: 3 }));
      fireEvent.click(screen.getByLabelText("One fewer"));
      expect(props.onQtyDelta).toHaveBeenCalledWith(-1);
    });
  });

  describe("quantity — a case-packed line", () => {
    it("Case mode edits whole cases and extra units through the row's handlers", () => {
      const props = setup(boxed());
      fireEvent.change(screen.getByLabelText("Cases"), { target: { value: "3" } });
      fireEvent.change(screen.getByLabelText("Extra units"), { target: { value: "2" } });
      expect(props.onSetBoxes).toHaveBeenLastCalledWith(3);
      expect(props.onSetPieces).toHaveBeenLastCalledWith(2);
    });

    it("extra units are capped below one case", () => {
      setup(boxed());
      expect(screen.getByLabelText("Extra units")).toHaveAttribute("max", "5");
    });

    it("the Case | Unit toggle drives onSetSellBy and reflects the current mode", () => {
      const props = setup(boxed({ sellBy: "case" }));
      expect(screen.getByRole("button", { name: "Case" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Unit" }));
      expect(props.onSetSellBy).toHaveBeenCalledWith("unit");
    });

    it("Unit mode edits a TOTAL unit count through onSetUnitQty", () => {
      const props = setup(boxed({ sellBy: "unit", qty: 12 }));
      fireEvent.change(screen.getByLabelText("Total units"), { target: { value: "7" } });
      expect(props.onSetUnitQty).toHaveBeenLastCalledWith(7);
      expect(screen.queryByLabelText("Cases")).not.toBeInTheDocument();
    });

    it("states the pack size and the unit total", () => {
      setup(boxed());
      expect(screen.getByText("1 case = 6 units · 12 units total")).toBeInTheDocument();
    });

    it("a non-boxed line has no case/unit toggle", () => {
      setup(line());
      expect(screen.queryByRole("button", { name: "Case" })).not.toBeInTheDocument();
    });
  });

  describe("line total (@routeflow/pricing, never re-derived)", () => {
    it("matches computeLineSubtotal for a plain line", () => {
      setup(line({ unitPrice: 8.99, qty: 3 }));
      expect(screen.getByText("$26.97")).toBeInTheDocument();
    });

    it("uses boxed proration for a case-packed line — not qty x price", () => {
      const li = boxed({ unitPrice: 24, boxes: 1, pieces: 1, qty: 7 });
      const expected = computeLineSubtotal({
        unitPrice: 24,
        qty: 7,
        boxes: 1,
        pieces: 1,
        unitsPerBox: 6,
      }).toFixed(2);
      setup(li);
      expect(screen.getByText(`$${expected}`)).toBeInTheDocument();
      expect(expected).not.toBe((24 * 7).toFixed(2));
      expect(screen.getByText("$4.00 / piece")).toBeInTheDocument();
    });
  });

  describe("the margin floor (the same MarginHint as the row — no bypass)", () => {
    it("embeds MarginHint with the row's exact props", () => {
      setup(line({ unitCost: 6, unitPrice: 7 }), { marginFloor: 0.2, floorAcked: true });
      expect(marginHintProps).toMatchObject({
        unitPrice: 7,
        unitCost: 6,
        floor: 0.2,
        acked: true,
        productId: "p1",
        concealed: false, // costRevealed: true
      });
    });

    it("'Set to floor' and 'Sell anyway' call the SAME handlers the row uses", () => {
      const props = setup(line());
      marginHintProps.onSetToFloor(9.5);
      marginHintProps.onSellAnyway();
      marginHintProps.onToggleConcealed();
      expect(props.onSetToFloor).toHaveBeenCalledWith(9.5);
      expect(props.onAckFloor).toHaveBeenCalledTimes(1);
      expect(props.onToggleCostRevealed).toHaveBeenCalledTimes(1);
    });

    it("keeps the cost concealed until revealed", () => {
      setup(line(), { costRevealed: false });
      expect(marginHintProps.concealed).toBe(true);
    });
  });

  describe("dismissal", () => {
    it("Done, the X and the backdrop all close it", () => {
      const props = setup(line());
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(screen.getByRole("button", { name: "Close price editor" }));
      expect(props.onClose).toHaveBeenCalledTimes(3);
    });
  });
});
