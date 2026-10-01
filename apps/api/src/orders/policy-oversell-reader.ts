import { Inject, Injectable } from "@nestjs/common";
import { PolicyService } from "../policy/policy.service";
import type { OversellPolicyReader } from "./oversell-policy";

/**
 * WS9: adapts `orders.buyerOversell` onto the pure `OversellPolicyReader` port. Reads the TENANT
 * layer, or the CUSTOMER layer over it when a customer is known. `PolicyService.resolve` never
 * throws and yields the registry default ("off") on any read error; `resolveOversellAllowed`
 * additionally fails closed if this reader ever throws. Call it BEFORE any FOR UPDATE (SA-606c).
 */
@Injectable()
export class PolicyOversellReader implements OversellPolicyReader {
  constructor(@Inject(PolicyService) private readonly policies: PolicyService) {}

  read(args: { tenantId: string; customerId?: string | null }): Promise<unknown> {
    const { tenantId, customerId } = args;
    return this.policies.resolve(
      tenantId,
      "orders.buyerOversell",
      customerId ? { customerId } : {},
    );
  }
}
