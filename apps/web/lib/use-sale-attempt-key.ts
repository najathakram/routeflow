import * as React from "react";
import { createSaleKeyHolder } from "@routeflow/types/sale-attempt";

/**
 * Row 485: the Idempotency-Key for one New-sale attempt (the counter holds its own in CounterSaleScreen).
 * `keyFor(fingerprint)` returns the held key while the cart/form is unchanged (any retry of the same
 * attempt) and mints a new one for a changed cart; `settle` drops it on a success or a definitive refusal
 * and keeps it for anything unknown, including every error that names a committed order or invoice.
 */
export function useSaleAttemptKey() {
  const ref = React.useRef<ReturnType<typeof createSaleKeyHolder> | null>(null);
  if (!ref.current) ref.current = createSaleKeyHolder();
  return ref.current;
}
