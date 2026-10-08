import type { FulfillPath } from "@prisma/client";
import type { SourceLines } from "./source-line";

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
 *  - `beforeWrite` (B1209): called with the SERVER-computed order total right after pricing and before any
 *    stock lock or transaction (never on a replay, never for a draft); a throw refuses with nothing written.
 */
export interface CreateOrderOptions {
  skipAutoMerge?: boolean;
  allowArchived?: boolean;
  sourceLines?: SourceLines;
  fulfillPath?: FulfillPath;
  counterSale?: boolean;
  onReplay?: (order: { id: string; status?: string; counterSale?: boolean }) => void;
  beforeWrite?: (priced: { total: number }) => void | Promise<void>;
}
