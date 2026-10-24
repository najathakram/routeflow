import { createNavShortcutHandler } from "./nav-shortcuts";
import {
  cancelCounterLeave,
  confirmCounterLeave,
  getCounterLeaveNotice,
  getCounterLeaveRequest,
  setCounterCartBusy,
  setCounterCartHasLines,
} from "./counter-cart-signal";

/**
 * The g shortcuts ask the counter's shared leave guard (`guardCounterLeave`) before every jump: an empty cart navigates at once,
 * a cart with lines parks the jump behind the Discard dialog (Discard runs the RAW push once, Keep selling drops it), a sale in
 * progress refuses with the notice. Typing in a text field never reaches any of it.
 */

const push = jest.fn();
let handler: (e: KeyboardEvent) => void;

const press = (...keys: string[]) =>
  keys.forEach((key) => handler(new KeyboardEvent("keydown", { key })));

beforeEach(() => {
  jest.clearAllMocks();
  handler = createNavShortcutHandler({
    push,
    routesAccess: true,
    counterEnabled: true,
    toggleHelp: jest.fn(),
  });
});

afterEach(() => {
  setCounterCartBusy(false);
  setCounterCartHasLines(false);
  document.body.innerHTML = "";
});

describe("g shortcuts and the counter leave guard", () => {
  it("an empty cart: g i navigates at once and opens no dialog", () => {
    press("g", "i");

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/invoices");
    expect(getCounterLeaveRequest()).toBe(false);
  });

  it("a cart with lines: g i parks the jump behind the Discard dialog instead of ignoring it", () => {
    setCounterCartHasLines(true);

    press("g", "i");

    expect(push).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(true);
  });

  it("Discard runs the raw push once; the parked jump is gone afterwards", () => {
    setCounterCartHasLines(true);
    press("g", "c");

    confirmCounterLeave();
    confirmCounterLeave();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/customers");
    expect(getCounterLeaveRequest()).toBe(false);
  });

  it("Keep selling drops the parked jump: nothing navigates", () => {
    setCounterCartHasLines(true);
    press("g", "i");

    cancelCounterLeave();
    confirmCounterLeave();

    expect(push).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(false);
  });

  it("a sale in progress: no navigation, no Discard dialog, the notice is raised", () => {
    setCounterCartHasLines(true);
    setCounterCartBusy(true);

    press("g", "i");
    press("g", "i");

    expect(push).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(false);
    expect(getCounterLeaveNotice()).toBe(true);
  });

  it("focus in a text field: the keys are typing, so no jump and no dialog even with lines", () => {
    setCounterCartHasLines(true);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    press("g", "i");

    expect(push).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(false);
  });
});
