import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import { setLineQty, type TypedQty } from "./counter-sale-line-edit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * Row 676 (SA-831b M13): ONE stepper that counts the line's selling unit, the unit always named beside it, and the
 * box/piece split re-derived by the same helpers as before. Cola 12oz Can, case of 24, $18.00 a case.
 */
const cola = (over: Partial<SaleLine> = {}): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Cola 12oz Can",
  unitPrice: 18,
  unitsPerBox: 24,
  boxes: 2,
  pieces: 0,
  qty: 48,
  ...over,
});

function mount(l: SaleLine) {
  const onStep = jest.fn();
  const onQty = jest.fn((_id: string, typed: TypedQty) => setLineQty(l, typed) !== null);
  render(
    <ul>
      <CounterLineRow
        line={l}
        locked={false}
        onStep={onStep}
        onRemove={() => undefined}
        onNote={() => undefined}
        onQty={onQty}
      />
    </ul>,
  );
  return { onStep, onQty };
}
const group = () => screen.getByRole("group", { name: "Quantity of Cola 12oz Can" });

describe("CounterLineRow: one stepper, the selling unit always named", () => {
  it("a boxed line has ONE stepper (minus, count, plus), not four step buttons and two fields", () => {
    mount(cola());
    expect(within(group()).getAllByRole("button")).toHaveLength(2);
    expect(within(group()).getAllByRole("spinbutton")).toHaveLength(1);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  });

  it("the unit is named beside the count, whatever the unit", () => {
    mount(cola());
    expect(screen.getByTestId("line-sell-unit")).toHaveTextContent("2 boxes");
    fireEvent.click(screen.getByRole("button", { name: "Sell Cola 12oz Can by the each" }));
    expect(screen.getByTestId("line-sell-unit")).toHaveTextContent("48 each");
  });

  it("the unit uses the product's pack word when it has one", () => {
    mount(cola({ packLabel: "Case", boxes: 1, qty: 24 }));
    expect(screen.getByTestId("line-sell-unit")).toHaveTextContent("1 case");
    expect(screen.getByRole("button", { name: "Sell Cola 12oz Can by the case" })).toBeVisible();
  });

  it("in Case the buttons step a whole case; in Each they step one piece (the same stepLine calls)", () => {
    const { onStep } = mount(cola());
    fireEvent.click(screen.getByRole("button", { name: "Add a box to Cola 12oz Can" }));
    expect(onStep).toHaveBeenLastCalledWith("t1", "box", 1);
    fireEvent.click(screen.getByRole("button", { name: "Remove a box from Cola 12oz Can" }));
    expect(onStep).toHaveBeenLastCalledWith("t1", "box", -1);
    fireEvent.click(screen.getByRole("button", { name: "Sell Cola 12oz Can by the each" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a piece to Cola 12oz Can" }));
    expect(onStep).toHaveBeenLastCalledWith("t1", "piece", 1);
    expect(screen.queryByRole("button", { name: "Add a box to Cola 12oz Can" })).toBeNull();
  });

  it("typing in Case sets whole cases; typing in Each sets pieces and the split is re-derived", () => {
    const { onQty } = mount(cola());
    const field = screen.getByRole("spinbutton", { name: "Boxes of Cola 12oz Can" });
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.blur(field);
    expect(onQty).toHaveBeenLastCalledWith("t1", { boxes: "3", pieces: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Sell Cola 12oz Can by the each" }));
    const each = screen.getByRole("spinbutton", { name: "Pieces of Cola 12oz Can" });
    fireEvent.change(each, { target: { value: "27" } });
    fireEvent.blur(each);
    expect(onQty).toHaveBeenLastCalledWith("t1", { boxes: "0", pieces: "27" });
  });

  it("a refused typed value still snaps back and says why", () => {
    mount(cola());
    const field = screen.getByRole("spinbutton", { name: "Boxes of Cola 12oz Can" });
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one/i);
    expect(field).toHaveValue(2);
  });

  it("a line holding loose pieces counts each, and Case waits until they are gone", () => {
    mount(cola({ boxes: 1, pieces: 3, qty: 27 }));
    expect(screen.getByTestId("line-sell-unit")).toHaveTextContent("27 each");
    expect(screen.getByRole("button", { name: "Sell Cola 12oz Can by the box" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sell Cola 12oz Can by the each" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a plain line keeps its own +/- and typed field, with its unit named and no Case/Each toggle", () => {
    mount({ tempId: "t2", productId: "p2", name: "Ice", unitPrice: 4, qty: 5, unit: "bag" });
    expect(screen.getByRole("button", { name: "Add one Ice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove one Ice" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Set quantity of Ice" })).toHaveValue(5);
    expect(screen.getByTestId("line-sell-unit")).toHaveTextContent("5 bags");
    expect(screen.queryByRole("button", { name: /Sell Ice by/ })).toBeNull();
  });
});
