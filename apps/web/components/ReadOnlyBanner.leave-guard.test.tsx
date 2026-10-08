import * as React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
import { setCounterCartBusy } from "@/lib/counter-cart-signal";

/** POS-7: plain <a href> links the shell can show over the counter obey the leave guard. */
afterEach(() => {
  cleanup();
  act(() => setCounterCartBusy(false));
});

describe("ReadOnlyBanner 'Choose a plan' link", () => {
  it("is cancelled while a sale is being recorded, and works when not busy", () => {
    render(<ReadOnlyBanner status="READ_ONLY" readOnlyReason={null} compact />);
    const link = screen.getByRole("link", { name: "Choose a plan" });
    expect(fireEvent.click(link)).toBe(true);
    act(() => setCounterCartBusy(true));
    expect(fireEvent.click(link)).toBe(false);
  });
});

describe("LockedPage 'See plans' link", () => {
  it("is cancelled while a sale is being recorded, and works when not busy", () => {
    render(
      <LockedPage
        gate={{
          code: "PLAN_GATE",
          flag: "flag.estimates",
          message: "no",
          upgrade: {
            planKey: null,
            planMonthlyPrice: null,
            addonSku: null,
            addonMonthlyPrice: null,
          },
        }}
      />,
    );
    const link = screen
      .getByRole("button", { name: /see plans/i })
      .closest("a") as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
    act(() => setCounterCartBusy(true));
    expect(fireEvent.click(link)).toBe(false);
  });
});
