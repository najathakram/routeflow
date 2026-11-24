import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { typeQty } from "@/test-utils/type-qty";

/** Row 676 (SA-831b M13 / row 531): a boxed line speaks the selling unit; a typed box count goes to onQty as boxes. B1373: the order row replaced the +/- step buttons. */

const noop = () => undefined;
const boxed = (over: Partial<SaleLine> = {}): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 18,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  qty: 24,
  ...over,
});

function renderRow(l: SaleLine, onStep: (id: string, u: StepUnit, d: 1 | -1) => void = noop) {
  return render(
    <ul>
      <CounterLineRow
        line={l}
        locked={false}
        onStep={onStep}
        onRemove={noop}
        onNote={noop}
        onQty={() => true}
      />
    </ul>,
  );
}

describe("CounterLineRow selling-unit entry (676, B1373)", () => {
  it("a boxed line speaks the selling unit: pack | pieces toggle, whole boxes, and the 1 box = 24 pcs footer", () => {
    renderRow(boxed());
    expect(screen.getByRole("button", { name: "Box" })).toBeInTheDocument();
    expect(screen.getByTitle(/^Number of whole box/)).toHaveValue(1);
    expect(screen.getByTestId("line-qty-controls")).toHaveTextContent("1 box = 24 pcs");
    expect(screen.getByTestId("line-qty-controls")).toHaveTextContent("24 pcs total");
  });

  it("the one-tap box/piece step buttons are gone from a boxed line (typed entry replaces them)", () => {
    renderRow(boxed());
    expect(screen.queryByRole("button", { name: "Add a box to Cola" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a piece to Cola" })).toBeNull();
  });

  it("typing boxes sends the typed boxes through onQty, never a piece step", () => {
    const onStep = jest.fn();
    const onQty = jest.fn(() => true);
    render(
      <ul>
        <CounterLineRow
          line={boxed()}
          locked={false}
          onStep={onStep}
          onRemove={noop}
          onNote={noop}
          onQty={onQty}
        />
      </ul>,
    );
    typeQty(screen.getByTitle(/^Number of whole box/), "2");
    expect(onQty).toHaveBeenCalledWith("t1", { boxes: "2" });
    expect(onStep).not.toHaveBeenCalled();
  });

  it("a box step lands on boxes = 2, pieces = 0 (the unit-line split, not 25 pieces)", () => {
    const next = stepLine(boxed(), "box", 1);
    expect(next.boxes).toBe(2);
    expect(next.pieces).toBe(0);
    expect(next.qty).toBe(48);
  });

  it("a piece step past the pack rolls over through normalizeBoxesPieces", () => {
    const next = stepLine(boxed({ boxes: 0, pieces: 23, qty: 23 }), "piece", 1);
    expect(next.boxes).toBe(1);
    expect(next.pieces).toBe(0);
    expect(next.qty).toBe(24);
  });

  it("a plain line keeps the bare + and − and shows its quantity in the field", () => {
    renderRow({ tempId: "t2", productId: "p2", name: "Gum", unitPrice: 1, qty: 2 });
    expect(screen.getByRole("button", { name: "Add one Gum" })).toHaveTextContent("+");
    expect(screen.getByRole("button", { name: "Add one Gum" })).not.toHaveTextContent("Box");
    expect(screen.getByRole("spinbutton", { name: "Set quantity of Gum" })).toHaveValue(2);
  });
});
