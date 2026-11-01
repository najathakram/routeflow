import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";

/** Row 676 (SA-831b M13 / row 531): the stepper speaks the selling unit, always visible, and a step sends boxes = 1. */

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

describe("CounterLineRow selling-unit stepper (676)", () => {
  it("the box step is labelled with the whole selling unit: '1 Box (24 pcs)'", () => {
    renderRow(boxed());
    expect(screen.getByRole("button", { name: "Add a box to Cola" })).toHaveTextContent(
      "+ 1 Box (24 pcs)",
    );
    expect(screen.getByRole("button", { name: "Remove a box from Cola" })).toHaveTextContent(
      "− 1 Box (24 pcs)",
    );
  });

  it("the piece step names one piece", () => {
    renderRow(boxed());
    expect(screen.getByRole("button", { name: "Add a piece to Cola" })).toHaveTextContent("+ 1 pc");
  });

  it("Add (the box step) sends the box unit, never a piece", () => {
    const onStep = jest.fn();
    renderRow(boxed(), onStep);
    fireEvent.click(screen.getByRole("button", { name: "Add a box to Cola" }));
    expect(onStep).toHaveBeenCalledWith("t1", "box", 1);
    expect(onStep).not.toHaveBeenCalledWith("t1", "piece", 1);
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

  it("a plain line keeps the bare + and −", () => {
    renderRow({ tempId: "t2", productId: "p2", name: "Gum", unitPrice: 1, qty: 2 });
    expect(screen.getByRole("button", { name: "Add one Gum" })).toHaveTextContent("+");
    expect(screen.getByRole("button", { name: "Add one Gum" })).not.toHaveTextContent("Box");
  });
});
