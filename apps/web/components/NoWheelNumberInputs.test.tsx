import * as React from "react";
import { render, screen } from "@testing-library/react";
import { NoWheelNumberInputs } from "@/components/NoWheelNumberInputs";

/**
 * Row 697: a FOCUSED <input type="number"> changes its value on the mouse wheel (qty 4 -> 3 or 5 pcs, $60.00 ->
 * $61.50) with no sign. jsdom never applies the browser's wheel-step, so the pin is the cancelled event: a wheel
 * that is defaultPrevented over a focused number input cannot step it in a real browser.
 */
const wheel = (el: Element, init: WheelEventInit = { deltaY: 100 }) => {
  const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};

describe("NoWheelNumberInputs (row 697)", () => {
  it("cancels a wheel over a focused number input rendered later, nested or in a portal", () => {
    const { rerender } = render(<NoWheelNumberInputs />);
    rerender(
      <>
        <NoWheelNumberInputs />
        <div>
          <label>
            Price
            <input type="number" defaultValue="60.00" />
          </label>
        </div>
      </>,
    );
    const price = screen.getByLabelText("Price") as HTMLInputElement;
    price.focus();
    expect(wheel(price).defaultPrevented).toBe(true);
  });

  it("leaves page scrolling alone when the number input is NOT focused", () => {
    render(
      <>
        <NoWheelNumberInputs />
        <input type="number" aria-label="Qty" defaultValue={4} />
        <input type="text" aria-label="Note" />
      </>,
    );
    expect(wheel(screen.getByLabelText("Qty")).defaultPrevented).toBe(false);
    expect(wheel(document.body).defaultPrevented).toBe(false);
  });

  it("never touches a focused non-number field or a ctrl+wheel zoom", () => {
    render(
      <>
        <NoWheelNumberInputs />
        <input type="text" aria-label="Note" />
        <input type="number" aria-label="Qty" defaultValue={4} />
      </>,
    );
    const note = screen.getByLabelText("Note") as HTMLInputElement;
    note.focus();
    expect(wheel(note).defaultPrevented).toBe(false);
    const qty = screen.getByLabelText("Qty") as HTMLInputElement;
    qty.focus();
    // Ctrl+wheel is the browser's page zoom, not a value step: keep it working.
    expect(wheel(qty, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("stops listening when unmounted", () => {
    const { unmount } = render(<NoWheelNumberInputs />);
    unmount();
    const host = document.createElement("div");
    host.innerHTML = '<input type="number" />';
    document.body.appendChild(host);
    const input = host.querySelector("input")!;
    input.focus();
    expect(wheel(input).defaultPrevented).toBe(false);
    host.remove();
  });
});
