import type { FulfillPath } from "@prisma/client";
import type { SourceLines } from "./source-line";

/**
 * `OrdersService.create`'s third argument. Every field is INTERNAL (never a request DTO field).
 *  - `fulfillPath` (SA-655): PICKUP is not a writable DTO value (writable-fulfill-paths.ts), so a counter
 *    sale can only arrive here. It beats `dto.fulfillPath` and the customer default.
 *  - `onReplay` (SA-655): called with the ORIGINAL order from both Idempotency-Key replay exits (the
 *    pre-check and the concurrent-race P2002), so a caller that chains more writes after create() knows
 *    it is resuming, not creating. Existing callers pass neither.
 */
export interface CreateOrderOptions {
  skipAutoMerge?: boolean;
  allowArchived?: boolean;
  sourceLines?: SourceLines;
  fulfillPath?: FulfillPath;
  onReplay?: (order: { id: string; status?: string }) => void;
}
