import * as React from "react";
import { scheduleScannerRefocus } from "@/lib/refocus-scanner";

/**
 * SA-762r (Web-1 #8): the counter's ONE scan-focus owner. Every "put the cursor back in the scan field" on the register goes
 * through `lib/refocus-scanner.ts` (the guarded B744 re-arm used by estimates, invoices/new, orders/[id] and the order modal):
 * it fires a tick later and skips when the clerk is typing in another text field (a line note, the tender, the customer
 * search), so a half-typed note is never swallowed by the scan lookup and a closed note hands the cursor back at once.
 *
 * The target is read when the timer FIRES: the customer search while a walk-in sale waits for the customer to ship to,
 * otherwise the scan field. Mount autofocus on the scan field and the note's own autofocus are the only direct focus
 * (counter-focus.structure.test.ts pins that no other counter file calls `.focus()`).
 */
export function useCounterScanFocus(refs: {
  scanRef: React.RefObject<HTMLInputElement | null>;
  customerFindRef: React.RefObject<HTMLInputElement | null>;
  awaitingCustomerRef: React.MutableRefObject<boolean>;
}): { refocus: () => void; focusCustomerFind: () => void; refocusFromActive: () => void } {
  const { scanRef, customerFindRef, awaitingCustomerRef } = refs;
  const armed = React.useMemo<React.RefObject<HTMLInputElement | null>>(
    () => ({
      get current() {
        return awaitingCustomerRef.current ? customerFindRef.current : scanRef.current;
      },
    }),
    [scanRef, customerFindRef, awaitingCustomerRef],
  );
  const refocus = React.useCallback(() => {
    scheduleScannerRefocus(armed, 0, { yieldFrom: [scanRef] });
  }, [armed, scanRef]);
  // Enter finished the field the clerk is in (a typed quantity): the cursor may leave it for the armed field.
  const refocusFromActive = React.useCallback(() => {
    scheduleScannerRefocus(armed, 0, {
      yieldFrom: [scanRef, { current: document.activeElement as HTMLElement | null }],
    });
  }, [armed, scanRef]);
  const focusCustomerFind = React.useCallback(() => {
    scheduleScannerRefocus(customerFindRef, 0, { yieldFrom: [scanRef] });
  }, [customerFindRef, scanRef]);
  return { refocus, focusCustomerFind, refocusFromActive };
}
