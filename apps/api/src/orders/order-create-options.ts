import { BadRequestException } from "@nestjs/common";
import type { FulfillPath } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { SourceLines } from "./source-line";
import type { OrderItemAuthorChannel } from "./line-author-channel";

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
 *  - `internalCustomerDraft` (F1 ii): INTERNAL only, never a DTO field. create() refuses a DRAFT from a CUSTOMER
 *    principal (ORDER_DRAFT_STAFF_ONLY); the one caller that drafts under the buyer pseudo-user on purpose is the
 *    not-on-truck change-request approval (a next-delivery draft), which sets this.
 */
export interface CreateOrderOptions {
  skipAutoMerge?: boolean;
  internalCustomerDraft?: boolean;
  allowArchived?: boolean;
  sourceLines?: SourceLines;
  fulfillPath?: FulfillPath;
  counterSale?: boolean;
  /**
   * The author marker every line of this create() is stamped with, instead of the acting principal's. Only the
   * not-on-truck change-request rollover sets it: its draft is created as the buyer pseudo-user, but the line is the
   * REQUESTER's (SA ruling #3418). Never a DTO field.
   */
  lineAuthor?: OrderItemAuthorChannel;
  priceEditAllowed?: boolean;
  onReplay?: (order: ReplayedOrder) => void;
  beforeWrite?: (priced: { total: number }) => void | Promise<void>;
}

/**
 * F1(ii): a CUSTOMER principal never starts a DRAFT order. A draft skips the selling-restrictions check until it
 * is promoted, so a buyer-started one would be judged only at the promoter's channel. Called FIRST in
 * `OrdersService.create`, the choke point no caller (controller, buyer module, internal caller) can go around.
 * The buyer DTO already forbids `status: DRAFT`; the one internal caller that drafts under the buyer pseudo-user
 * on purpose (the not-on-truck change-request approval) passes `internalCustomerDraft`.
 */
export function assertCustomerMayNotDraft(
  status: string | null | undefined,
  role: string | null | undefined,
  options: CreateOrderOptions,
): void {
  if (status !== "DRAFT" || role !== "CUSTOMER" || options.internalCustomerDraft) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.ORDER_DRAFT_STAFF_ONLY,
    message: "Only staff can save an order as a draft.",
  });
}
