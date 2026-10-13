import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";
import { setLineQty } from "./counter-sale-line-edit";
import {
  QTY_NEGATIVE_COPY,
  QTY_NOT_A_NUMBER_COPY,
  QTY_NOT_WHOLE_COPY,
  QTY_ZERO_COPY,
} from "./counter-qty-refusal";

/**
 * CQ-12: a typed quantity the screen refuses (0, negative, letters, a fraction) snaps back AND says why, in the row. What is
 * accepted is unchanged: the row asks `setLineQty` (the real rule) and only words the refusal.
 */
const base: SaleLine = { tempId: "t1", productId: "p1", name: "Cola", unitPrice: 2.5, qty: 3 };

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
const type = (field: HTMLElement, v: string) => {
  fireEvent.change(field, { target: { value: v } });
  fireEvent.blur(field);
};

describe("CounterLineRow typed quantity refusals (CQ-12)", () => {
  it.each([
    ["0", QTY_ZERO_COPY],
    ["-2", QTY_NEGATIVE_COPY],
    ["1.5", QTY_NOT_WHOLE_COPY],
    ["abc", QTY_NOT_A_NUMBER_COPY], // a number field reports letters as ""
  ])("%j: the field snaps back to 3 and explains itself", (v, copy) => {
    const { field } = mount();
    type(field, v);
    expect(screen.getByRole("alert")).toHaveTextContent(copy);
    expect(field).toHaveValue(3);
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("the message goes as soon as the clerk types again, and an accepted value shows none", () => {
    const { field, onQty } = mount();
    type(field, "0");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "4" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(field);
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
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    expect(onQty).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveValue(3);
  });

  it("1e3 gets the generic whole-number line, not 'at least 1'", () => {
    const { field } = mount();
    type(field, "1e3");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 1.");
  });

  it("Escape drops the draft and any message", () => {
    const { field } = mount();
    type(field, "0");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
