import { Injectable } from "@nestjs/common";
import { UNSET_CAPABILITY, type FulfilmentCapability } from "./capability-shape";

/** DI token for the reader the counter-sale gate asks "what can this tenant do?". */
export const FULFILMENT_CAPABILITY_READER = Symbol("FULFILMENT_CAPABILITY_READER");

export interface FulfilmentCapabilityReader {
  get(tenantId: string | null): Promise<FulfilmentCapability>;
}

/**
 * Until PR #3188's `deriveFulfilmentCapability` is on master this returns the "unset = today"
 * capability for everyone (counter off), so the endpoint is dark and production behaviour is unchanged.
 * TODO(#3188): swap for a reader that derives the capability from the tenant's fulfilment_model /
 * counter_sales config rows.
 */
@Injectable()
export class DefaultFulfilmentCapabilityReader implements FulfilmentCapabilityReader {
  async get(_tenantId: string | null): Promise<FulfilmentCapability> {
    return UNSET_CAPABILITY;
  }
}
