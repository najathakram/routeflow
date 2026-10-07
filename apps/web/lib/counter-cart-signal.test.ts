import {
  getCounterCartBusy,
  setCounterCartBusy,
  getCounterCartHasLines,
  setCounterCartHasLines,
  subscribeCounterCart,
} from "./counter-cart-signal";

/** POS-7: the one-bit "the counter cart has lines" store the register header reads (no React context). */

afterEach(() => {
  setCounterCartHasLines(false);
  setCounterCartBusy(false);
});

describe("counter cart signal", () => {
  it("starts false, is set and cleared", () => {
    expect(getCounterCartHasLines()).toBe(false);
    setCounterCartHasLines(true);
    expect(getCounterCartHasLines()).toBe(true);
    setCounterCartHasLines(false);
    expect(getCounterCartHasLines()).toBe(false);
  });

  it("notifies subscribers on a change only, and stops after unsubscribe", () => {
    const fn = jest.fn();
    const off = subscribeCounterCart(fn);
    setCounterCartHasLines(true);
    setCounterCartHasLines(true);
    expect(fn).toHaveBeenCalledTimes(1);
    setCounterCartHasLines(false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    setCounterCartHasLines(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("carries a busy bit beside hasLines: set, cleared, notifies on change only", () => {
    const fn = jest.fn();
    const off = subscribeCounterCart(fn);
    expect(getCounterCartBusy()).toBe(false);
    setCounterCartBusy(true);
    setCounterCartBusy(true);
    expect(getCounterCartBusy()).toBe(true);
    expect(getCounterCartHasLines()).toBe(false); // independent bits
    expect(fn).toHaveBeenCalledTimes(1);
    setCounterCartBusy(false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });
});
