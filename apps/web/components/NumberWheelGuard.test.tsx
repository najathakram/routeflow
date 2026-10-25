import * as React from "react";
import { render, fireEvent } from "@testing-library/react";
import { NumberWheelGuard } from "./NumberWheelGuard";

/** Row 697 (F25): a wheel over a FOCUSED number input must never change it (a silent money change). jsdom has no
 *  native wheel-to-value, so the guard's contract is asserted as the cancelled default action. */
function wheel(el: Element) {
  const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
  el.dispatchEvent(ev);
  return ev;
}

describe("NumberWheelGuard", () => {
  it("cancels the wheel over the focused qty input and leaves its value and focus alone", () => {
    const { getByLabelText } = render(
      <>
        <NumberWheelGuard />
        <label>
          Qty <input type="number" defaultValue={4} />
        </label>
      </>,
    );
    const qty = getByLabelText("Qty") as HTMLInputElement;
    qty.focus();
    const ev = wheel(qty);
    expect(ev.defaultPrevented).toBe(true);
    expect(qty.value).toBe("4");
    expect(document.activeElement).toBe(qty);
  });

  it("leaves page scroll alone over an unfocused number input and over other fields", () => {
    const { getByLabelText } = render(
      <>
        <NumberWheelGuard />
        <input aria-label="n" type="number" defaultValue={4} />
        <input aria-label="t" type="text" defaultValue="x" />
      </>,
    );
    expect(wheel(getByLabelText("n")).defaultPrevented).toBe(false);
    const t = getByLabelText("t") as HTMLInputElement;
    t.focus();
    expect(wheel(t).defaultPrevented).toBe(false);
  });

  it("stops guarding once unmounted", () => {
    const { getByLabelText, unmount } = render(
      <>
        <NumberWheelGuard />
        <input aria-label="n" type="number" />
      </>,
    );
    const n = getByLabelText("n") as HTMLInputElement;
    n.focus();
    unmount();
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    document.body.appendChild(n);
    n.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    fireEvent.blur(n);
  });
});
