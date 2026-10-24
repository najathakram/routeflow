import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/**
 * W-717 / register calm: ONE visual weight per role on a sale line. The stepper is the primary control (a bordered pill);
 * Edit price, Add note and Clear note are quiet text links; remove is an icon button with a name. Every one stays a 44 px
 * target on touch widths (jsdom: class pins), and the line draws no white block of its own.
 */
const cola: SaleLine = {
  tempId: "t1",
  productId: "p1",
  name: "Cola 12oz Can",
  unitPrice: 18,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  qty: 24,
  note: "Lime",
};

function mount(l: SaleLine = cola) {
  render(
    <ul>
      <CounterLineRow
        line={l}
        locked={false}
        canEditPrices
        onStep={() => undefined}
        onRemove={() => undefined}
        onNote={() => undefined}
        onQty={() => true}
      />
    </ul>,
  );
}

describe("CounterLineRow: one weight per role", () => {
  it("the stepper is the one bordered primary control", () => {
    mount();
    const stepper = screen.getByRole("group", { name: "Quantity of Cola 12oz Can" });
    expect(stepper).toHaveClass("border");
    expect(stepper).toHaveClass("rounded-lg");
    for (const b of within(stepper).getAllByRole("button")) expect(b).toHaveClass("min-h-[44px]");
  });

  it("Add note, Edit note and Clear note are quiet text links, not bordered buttons", () => {
    mount();
    for (const name of ["Edit the note on Cola 12oz Can", "Clear the note on Cola 12oz Can"]) {
      const b = screen.getByRole("button", { name });
      expect(b).not.toHaveClass("border");
      expect(b).toHaveClass("underline");
      expect(b).toHaveClass("min-h-[44px]");
    }
  });

  it("Add note on a line with no note is the same quiet link", () => {
    mount({ ...cola, note: undefined });
    const b = screen.getByRole("button", { name: "Add a note to Cola 12oz Can" });
    expect(b).not.toHaveClass("border");
    expect(b).toHaveClass("underline");
    expect(b).toHaveClass("min-h-[44px]");
    fireEvent.click(b);
    expect(b).toHaveAttribute("aria-expanded", "true");
  });

  it("remove is an icon button with a name and no text", () => {
    mount();
    const remove = screen.getByRole("button", { name: "Remove Cola 12oz Can" });
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove).toHaveTextContent("");
    expect(remove).not.toHaveClass("border");
    expect(remove).toHaveClass("min-h-[44px]");
    expect(remove).toHaveClass("min-w-[44px]");
  });

  it("no control on the line shares the stepper's bordered look except the stepper", () => {
    mount();
    const li = screen.getByRole("listitem");
    // the price button is CounterLinePriceEdit's own Button (its link styling is that file's change): not asserted here
    const bordered = [...li.querySelectorAll("button, input")]
      .filter((el) => el.classList.contains("border"))
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => !/ price for /.test(label));
    expect(bordered).toEqual([]);
  });

  it("the line paints no white block of its own", () => {
    mount();
    const li = screen.getByRole("listitem");
    expect(li.className).not.toMatch(/bg-white/);
    expect(li.querySelectorAll('[class*="bg-white"]')).toHaveLength(0);
  });
});
