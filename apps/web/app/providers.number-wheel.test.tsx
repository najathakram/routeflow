import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "./providers";

jest.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Row 697 (behavioural pin, imports no helper): through the REAL app shell, a wheel over a FOCUSED number input
 * must be cancelled, or the browser steps the value (Edit Items qty 4 -> 3/5 pcs, $60.00 -> $61.50) unnoticed.
 */
const wheel = (el: Element) => {
  const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
  el.dispatchEvent(ev);
  return ev;
};

describe("Providers shell blocks wheel edits on number inputs (row 697)", () => {
  it("cancels the wheel over a focused number input", () => {
    render(
      <Providers>
        <input type="number" aria-label="Qty" defaultValue={4} />
      </Providers>,
    );
    const qty = screen.getByLabelText("Qty") as HTMLInputElement;
    qty.focus();
    expect(wheel(qty).defaultPrevented).toBe(true);
    expect(qty.value).toBe("4");
  });

  it("lets the page scroll when the number input is not focused", () => {
    render(
      <Providers>
        <input type="number" aria-label="Qty" defaultValue={4} />
      </Providers>,
    );
    expect(wheel(screen.getByLabelText("Qty")).defaultPrevented).toBe(false);
  });
});
