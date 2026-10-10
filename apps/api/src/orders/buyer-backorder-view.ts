import { Inject, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PolicyService } from "../policy/policy.service";
import { resolveOversellAllowed } from "./oversell-policy";
import {
  NO_BACKORDER_VIEW,
  parseBackorderVisibility,
  type BuyerBackorderView,
} from "./backorder-visibility";

import { PolicyOversellReader } from "./policy-oversell-reader";

export * from "./backorder-visibility";

/**
 * OOS PR2 (SA-714 R2/R3): what ONE buyer may do and be told about out-of-stock items.
 *
 * - `canBackorder`: `resolveOversellAllowed({ source: "buyer", role: CUSTOMER, customerId })`, the
 *   same predicate that decides a buyer order, so a catalog row and the order it leads to can never
 *   disagree. Resolved ONCE per request (never per product) by `BuyerBackorderViewResolver`.
 * - `visibility`: the seller's `orders.buyerBackorderVisibility` ("show" | "hide", fail-closed to
 *   "show"). It only means anything where the buyer can backorder: for a buyer who cannot, stock stays
 *   truthful (no masking), so the policy is not even read.
 */
@Injectable()
export class BuyerBackorderViewResolver {
  constructor(
    @Inject(PolicyOversellReader) private readonly oversell: PolicyOversellReader,
    @Inject(PolicyService) private readonly policies: PolicyService,
  ) {}

  /** One resolution for one buyer. Never rejects; any failure is the truthful view. */
  async resolve(args: {
    tenantId: string | null | undefined;
    customerId: string | null | undefined;
  }): Promise<BuyerBackorderView> {
    if (!args.tenantId || !args.customerId) return NO_BACKORDER_VIEW;
    const canBackorder = await resolveOversellAllowed(this.oversell, {
      tenantId: args.tenantId,
      role: UserRole.CUSTOMER,
      source: "buyer",
      customerId: args.customerId,
    });
    if (!canBackorder) return NO_BACKORDER_VIEW;
    try {
      const raw = await this.policies.resolve(args.tenantId, "orders.buyerBackorderVisibility", {});
      return { canBackorder, visibility: parseBackorderVisibility(raw) };
    } catch {
      return { canBackorder, visibility: "show" };
    }
  }
}
