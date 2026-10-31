import * as React from "react";
import { renderHook } from "@testing-library/react";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { useCounterScanFocus } from "./useCounterScanFocus";

/**
 * SA-1059: on a touch-first device the cursor never goes back to the SCAN field (the keyboard would rise over the camera). The
 * armed target is read when the re-arm timer FIRES, so a re-arm scheduled while a walk-in sale waited for its customer must
 * not land on the scan field if the customer arrived before the timer did.
 */
const setTouchFirst = (touch: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q === TOUCH_FIRST_QUERY ? touch : false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
};
const tick = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const scan = document.createElement("input");
  const customer = document.createElement("input");
  document.body.append(scan, customer);
  const awaiting = { current: true };
  const view = renderHook(() =>
    useCounterScanFocus({
      scanRef: { current: scan } as React.RefObject<HTMLInputElement>,
      customerFindRef: { current: customer } as React.RefObject<HTMLInputElement>,
      awaitingCustomerRef: awaiting,
    }),
  );
  return { scan, customer, awaiting, ...view };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).matchMedia;
  document.body.innerHTML = "";
});

describe("the armed target is read when the timer fires", () => {
  it("touch-first: a re-arm scheduled while the customer was awaited does not focus the scan field once they are chosen", async () => {
    setTouchFirst(true);
    const { result, scan, customer, awaiting } = setup();
    result.current.refocus(); // awaiting the customer: the customer search is the armed field
    awaiting.current = false; // the customer is chosen before the timer fires
    await tick();
    expect(document.activeElement).not.toBe(scan);
    expect(document.activeElement).not.toBe(customer);
  });

  it("touch-first: while the customer is still awaited the customer search takes focus", async () => {
    setTouchFirst(true);
    const { result, customer } = setup();
    result.current.refocus();
    await tick();
    expect(document.activeElement).toBe(customer);
  });

  it("a desktop till still re-arms the scan field", async () => {
    setTouchFirst(false);
    const { result, scan, awaiting } = setup();
    result.current.refocus();
    awaiting.current = false;
    await tick();
    expect(document.activeElement).toBe(scan);
  });
});
