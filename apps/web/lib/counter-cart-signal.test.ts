import {
  guardCounterLeave,
  getCounterLeaveRequest,
  confirmCounterLeave,
  cancelCounterLeave,
  getCounterLeaveNotice,
  getCounterCartBusy,
  setCounterCartBusy,
  getCounterCartHasLines,
  setCounterCartHasLines,
  subscribeCounterCart,
  setCounterAutoParkHook,
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

  it("guardCounterLeave blocks and raises the notice only while busy; settling clears the notice", () => {
    expect(guardCounterLeave()).toBe(false);
    expect(getCounterLeaveNotice()).toBe(false);
    setCounterCartBusy(true);
    expect(guardCounterLeave()).toBe(true);
    expect(getCounterLeaveNotice()).toBe(true);
    setCounterCartBusy(false);
    expect(getCounterLeaveNotice()).toBe(false);
    expect(guardCounterLeave()).toBe(false);
  });

  it("with lines and a proceed, the guard parks the leave and asks; confirm runs it once, cancel drops it", () => {
    const proceed = jest.fn();
    expect(guardCounterLeave(proceed)).toBe(false); // empty cart: caller goes on itself
    setCounterCartHasLines(true);
    expect(guardCounterLeave(proceed)).toBe(true);
    expect(getCounterLeaveRequest()).toBe(true);
    expect(proceed).not.toHaveBeenCalled();
    confirmCounterLeave();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(getCounterLeaveRequest()).toBe(false);
    confirmCounterLeave();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(guardCounterLeave(proceed)).toBe(true);
    cancelCounterLeave();
    expect(getCounterLeaveRequest()).toBe(false);
    confirmCounterLeave();
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("busy still wins over the Discard request", () => {
    setCounterCartHasLines(true);
    setCounterCartBusy(true);
    expect(guardCounterLeave(jest.fn())).toBe(true);
    expect(getCounterLeaveRequest()).toBe(false);
    expect(getCounterLeaveNotice()).toBe(true);
  });
});

/** W-1184: leaving with lines PARKS the sale, then leaves; the "Discard this sale?" question is only the fallback. */
describe("guardCounterLeave auto-parks", () => {
  afterEach(() => setCounterAutoParkHook(null));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("parks first, then runs the leave, and never opens the Discard dialog", async () => {
    const order: string[] = [];
    setCounterAutoParkHook(async () => {
      order.push("park");
      return true;
    });
    setCounterCartHasLines(true);
    const proceed = jest.fn(() => order.push("leave"));
    expect(guardCounterLeave(proceed)).toBe(true);
    expect(getCounterLeaveRequest()).toBe(false);
    await flush();
    expect(order).toEqual(["park", "leave"]);
  });

  it("a failed park keeps the sale and falls back to the Discard question (nothing is lost)", async () => {
    setCounterAutoParkHook(async () => false);
    setCounterCartHasLines(true);
    const proceed = jest.fn();
    expect(guardCounterLeave(proceed)).toBe(true);
    await flush();
    expect(proceed).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(true);
    cancelCounterLeave();
  });

  it("a second leave while the park runs does not park twice", async () => {
    const hook = jest.fn(async () => {
      await flush();
      return true;
    });
    setCounterAutoParkHook(hook);
    setCounterCartHasLines(true);
    const a = jest.fn();
    const b = jest.fn();
    expect(guardCounterLeave(a)).toBe(true);
    expect(guardCounterLeave(b)).toBe(true);
    await flush();
    await flush();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("busy still wins: no park while a sale is being recorded", () => {
    const hook = jest.fn(async () => true);
    setCounterAutoParkHook(hook);
    setCounterCartHasLines(true);
    setCounterCartBusy(true);
    expect(guardCounterLeave(jest.fn())).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });
});
