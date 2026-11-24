import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import { typeQty } from "@/test-utils/type-qty";
import type { SaleLine } from "./counter-sale-scan";
import { setLineQty } from "./counter-sale-line-edit";
import { QTY_TOO_LARGE_COPY } from "./counter-qty-refusal";

/**
 * CQ-12 (B1373: the order row's number field): a typed quantity the screen refuses snaps back (the field shows the line's
 * quantity). The row asks `setLineQty` (the real rule); a typed 0 or less is said by the order row's own "at least 1" note,
 * and the cap alone is said by the till's refusal line. The field commits live on change (no blur step).
 */
const base: SaleLine = { tempId: "t1", productId: "p1", name: "Cola", unitPrice: 2.5, qty: 3 };
const AT_LEAST_ONE = "Quantity must be at least 1. Remove the line to drop it.";

function mount() {
  const onQty = jest.fn((_id: string, typed: { qty?: string }) => setLineQty(base, typed) !== null);
  render(
    <ul>
      <CounterLineRow
        line={base}
        locked={false}
        onStep={() => undefined}
        onRemove={() => undefined}
        onNote={() => undefined}
        onQty={onQty}
      />
    </ul>,
  );
  return { onQty, field: screen.getByRole("spinbutton", { name: "Set quantity of Cola" }) };
}
const type = (field: HTMLElement, v: string) => typeQty(field, v);

describe("CounterLineRow typed quantity refusals (CQ-12)", () => {
  it.each([
    ["0", "0"],
    ["-2", "-2"],
  ])("%j: the line is refused, the field snaps back to 3 and the row says why", (v, sent) => {
    const { field, onQty } = mount();
    type(field, v);
    expect(onQty).toHaveBeenLastCalledWith("t1", { qty: sent });
    expect(screen.getByRole("status")).toHaveTextContent(AT_LEAST_ONE);
    expect(field).toHaveValue(3);
  });

  it("the message goes as soon as the clerk types again, and an accepted value shows none", () => {
    const { field, onQty } = mount();
    type(field, "0");
    expect(screen.getByRole("status")).toBeInTheDocument();
    type(field, "4");
    expect(screen.queryByRole("status")).toBeNull();
    expect(onQty).toHaveBeenLastCalledWith("t1", { qty: "4" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a clean whole number the screen did not take (locked, sale in flight) shows no made-up reason", () => {
    const onQty = jest.fn(() => false);
    render(
      <ul>
        <CounterLineRow
          line={base}
          locked={false}
          onStep={() => undefined}
          onRemove={() => undefined}
          onNote={() => undefined}
          onQty={onQty}
        />
      </ul>,
    );
    const field = screen.getByRole("spinbutton", { name: "Set quantity of Cola" });
    type(field, "5");
    expect(onQty).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(field).toHaveValue(3);
  });

  it("boxes that fit alone but push the line over 100,000 pieces say so (W-833)", () => {
    const boxedLine: SaleLine = { ...base, unitsPerBox: 12, boxes: 1, pieces: 0, qty: 12 };
    const onQty = jest.fn(
      (_id: string, typed: { boxes?: string }) => setLineQty(boxedLine, typed) !== null,
    );
    render(
      <ul>
        <CounterLineRow
          line={boxedLine}
          locked={false}
          onStep={() => undefined}
          onRemove={() => undefined}
          onNote={() => undefined}
          onQty={onQty}
        />
      </ul>,
    );
    type(screen.getByTitle(/^Number of whole box/), "9000");
    expect(screen.getByRole("alert")).toHaveTextContent(QTY_TOO_LARGE_COPY);
  });
});
