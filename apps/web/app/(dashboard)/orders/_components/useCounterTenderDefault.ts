"use client";

import * as React from "react";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import { useCounterDefaultTender } from "@/lib/api/counter-customer-credit";

/**
 * SA-933 / W-822(a): picking a customer sets the tender to their default (Net N is On account, Due on Receipt and a walk-in
 * are Cash), but only while nobody has DECIDED the tender in this sale. `decide()` is called by the clerk's own tender
 * choice and by every restore of a saved sale (a held attempt and its replay, a resumed parked sale, a cart restored after a
 * refresh); `reset()` by a new sale. Once decided, the default never touches the method again.
 */
export function useCounterTenderDefault({
  customerId,
  setMethod,
}: {
  /** the picked account customer; null for a walk-in (or none yet) */
  customerId: string | null;
  setMethod: (m: CounterSalePaymentMethod) => void;
}) {
  const tender = useCounterDefaultTender(customerId);
  const decidedRef = React.useRef(false);
  // A walk-in only takes the default back from a customer's: at mount (nothing picked) the method is left exactly as it is.
  const appliedRef = React.useRef(false);
  React.useEffect(() => {
    if (decidedRef.current) return;
    if (tender === null) {
      // The new customer's terms are not known (still reading, or the read failed): the previous customer's default must
      // not ride along. Back to Cash until they are known.
      if (customerId !== null && appliedRef.current) {
        appliedRef.current = false;
        setMethod("CASH");
      }
      return;
    }
    if (customerId === null && !appliedRef.current) return;
    appliedRef.current = customerId !== null;
    setMethod(tender);
    // customerId: another customer with the same default re-applies it after a walk-in fallback
  }, [tender, customerId, setMethod]);
  const decide = React.useCallback(() => {
    decidedRef.current = true;
  }, []);
  const reset = React.useCallback(() => {
    decidedRef.current = false;
    appliedRef.current = false;
  }, []);
  // `defaultTender` is what the customer's terms resolved to (null while unknown): the till lists it first.
  return { decide, reset, defaultTender: tender };
}
