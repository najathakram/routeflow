import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { CounterLinePriceEdit, type CounterLinePriceEditProps } from "./CounterLinePriceEdit";
import type { PriceEditLine } from "@/lib/counter-price-edit";

/**
 * SA-1071 P1: a past price picked from the history panel applies at once on an ordinary line. The dialog opens, prefilled,
 * only when the shared reason rule (inside `resolveCounterPriceEdit`) asks for a reason or refuses the number. `onApply`
 * stays the one write.
 */
const plain: PriceEditLine = { tierPrice: 10, listPrice: 10, tier: 1, qty: 2, unitWord: "each" };
const special: PriceEditLine = { ...plain, tier: 4, isSpecial: true };
const DIALOG = { name: "Change the price for Cola" };

function mount(over: Partial<CounterLinePriceEditProps> = {}) {
  const onApply = jest.fn();
  const onClosed = jest.fn();
  const props = {
    canEditPrices: true,
    name: "Cola",
    line: plain,
    customerName: "Acme",
    onApply,
    onClosed,
    ...over,
  } as CounterLinePriceEditProps;
  const utils = render(<CounterLinePriceEdit {...props} openWith={null} />);
  const pick = (value: number) =>
    utils.rerender(<CounterLinePriceEdit {...props} openWith={{ value }} />);
  return { ...utils, onApply, onClosed, pick };
}

describe("SA-1071 P1: Use on an ordinary line applies at once", () => {
  it("P1: no dialog, one onApply for the picked price", () => {
    const { onApply, pick } = mount();
    pick(9);
    expect(screen.queryByRole("dialog", DIALOG)).toBeNull();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({
      mode: "set",
      value: 9,
      unitPrice: 9,
      override: true,
    });
  });

  it("P1: the same price picked twice is two applies, never a stale skip", () => {
    const { onApply, pick } = mount();
    pick(9);
    pick(9);
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("P1: a price within half a cent of the tier price clears the override (override false), no dialog", () => {
    const { onApply, pick } = mount();
    pick(10.004);
    expect(screen.queryByRole("dialog", DIALOG)).toBeNull();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ unitPrice: 10, override: false });
  });

  it("P1: a locked line applies nothing and opens nothing", () => {
    const { onApply, pick } = mount({ locked: true });
    pick(9);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("P1: a boxed line is priced by its box through the same resolver", () => {
    const boxed: PriceEditLine = {
      ...plain,
      tierPrice: 24,
      listPrice: 24,
      boxes: 1,
      pieces: 6,
      unitsPerBox: 12,
    } as PriceEditLine;
    const { onApply, pick } = mount({ line: boxed });
    pick(21);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ mode: "set", value: 21, unitPrice: 21 });
  });

  it("P1a: a special-tier line with a real change opens the dialog prefilled and writes nothing", () => {
    const { onApply, pick } = mount({ line: special });
    pick(9);
    expect(screen.getByRole("dialog", DIALOG)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Price per item" })).toHaveValue("9.00");
    expect(screen.getByRole("textbox", { name: "Reason (required)" })).toHaveValue("");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("P1a: a refused number (over the unit price limit) opens the dialog, no write", () => {
    const { onApply, pick } = mount();
    pick(99999999);
    expect(screen.getByRole("dialog", DIALOG)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("P1: no grant (canEditPrices false) renders nothing and applies nothing", () => {
    const { onApply, pick } = mount({ canEditPrices: false });
    pick(9);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("P1: the screen's scan field gets focus back after an at-once apply (onClosed, once)", () => {
    jest.useFakeTimers();
    try {
      const { onClosed, pick } = mount();
      pick(9);
      act(() => {
        jest.runAllTimers();
      });
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
