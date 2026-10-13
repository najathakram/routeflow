import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { counterSaleGate } from "./capability-shape";
import type { FulfilmentCapabilityReader } from "./fulfilment-capability-reader";

/**
 * The ONE COUNTER_SALES_DISABLED check: the tenant's fulfilment capability must offer a counter, else 403
 * `COUNTER_SALES_DISABLED`. `POST /orders/counter-sale` and every parked-sale route (counter-park.service.ts) call it
 * first, so the refusal and its body are identical on all of them.
 */
export async function assertCounterSalesEnabled(
  capability: FulfilmentCapabilityReader,
  tenantId: string | null,
): Promise<void> {
  const cap = await capability.get(tenantId);
  if (!counterSaleGate(cap)) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.COUNTER_SALES_DISABLED,
      message: "Counter sales are not turned on for this business.",
    });
  }
}
