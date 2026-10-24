/**
 * Row 485: the Idempotency-Key for one New-sale attempt on the mobile composer. The rule itself (what is a
 * definitive refusal, when a key is reused or dropped) is the ONE shared `@routeflow/types/sale-attempt`,
 * the same one the web counter and web New sale use; this file is the mobile entry point so the screen and
 * its tests import from `lib/`.
 *
 *  - `keyFor(fingerprint)`: the held key while the cart/form fingerprint is unchanged (a retry of the same
 *    attempt: an unknown outcome, a network error, a 5xx, an error naming a committed order or invoice),
 *    a new key for a changed cart or after a settled attempt.
 *  - `settle(outcome)`: clears the key ONLY on a success or a definitive refusal that names no committed sale.
 */
import { createSaleKeyHolder } from "@routeflow/types/sale-attempt";

export { isDefinitiveSaleRefusal } from "@routeflow/types/sale-attempt";
export const createSaleAttemptKey = createSaleKeyHolder;
export type SaleAttemptKey = ReturnType<typeof createSaleKeyHolder>;
