import type { FulfillPath } from "@prisma/client";
import type { SourceLines } from "./source-line";

/** The ORIGINAL order a replay hands back (create()'s replay lookup includes its lines). */
export interface ReplayedOrder {
  id: string;
  status?: string;
  counterSale?: boolean;
  lineItems?: ReadonlyArray<{
    productId?: string | null;
    position?: number | null;
    status?: string | null;
    unitPrice?: unknown;
    overriddenBy?: string | null;
  }> | null;
}

/**
 * `OrdersService.create`'s third argument. Every field is INTERNAL (never a request DTO field).
 *  - `fulfillPath` (SA-655): PICKUP is not a writable DTO value (writable-fulfill-paths.ts), so a counter
 *    sale can only arrive here. It beats `dto.fulfillPath` and the customer default.
 *  - `counterSale` (SA-672e): persisted as Order.counterSale; ONLY the counter-sale POST sets it, and GET
 *    by-key matches on it.
 *  - `onReplay` (SA-655): called with the ORIGINAL order from both Idempotency-Key replay exits (the
 *    pre-check and the concurrent-race P2002), so a caller that chains more writes after create() knows
 *    it is resuming, not creating. The key lookup itself does NOT filter on Order.counterSale (keys are
 *    client UUIDs per tenant, a pre-existing property), so the counter POST's onReplay guard is what
 *    refuses a key that belongs to an ordinary staff/buyer order. Existing callers pass neither.
 *  - `priceEditAllowed` (POS-5): ONLY the counter sale sets it, to `staffMay(user.role, "EDIT_LINE_PRICE")`. `false` refuses a line
 *    that WOULD be a real staff price override (DISCOUNTED / MANUAL, judged against the server's own tier price)
 *    with 403 PRICE_EDIT_NOT_PERMITTED, before anything is written; a typed price within 1/2 cent of the server's
 *    is no override and passes. `undefined` (every other caller) and `true` change nothing.
 *  - `beforeWrite` (B1209): called with the SERVER-computed order total right after pricing and before any
 *    stock lock or transaction (never on a replay, never for a draft); a throw refuses with nothing written.
 */
export interface CreateOrderOptions {
  skipAutoMerge?: boolean;
  allowArchived?: boolean;
  sourceLines?: SourceLines;
  fulfillPath?: FulfillPath;
  counterSale?: boolean;
  priceEditAllowed?: boolean;
  onReplay?: (order: ReplayedOrder) => void;
  beforeWrite?: (priced: { total: number }) => void | Promise<void>;
}
