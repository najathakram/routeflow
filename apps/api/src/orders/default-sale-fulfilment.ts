import { resolveFulfilPath } from "./fulfil-path-resolver";
import type { PrismaService } from "../prisma/prisma.service";
import {
  saleFulfilmentKind,
  type SaleFulfilmentKind,
} from "../selling-restrictions/sale-fulfilment";
import { storedFulfilmentMode } from "../selling-restrictions/tenant-fulfilment-model";

/**
 * L8: the kind for a sale that has NO order of its own (a manual invoice, an estimate converted to an invoice, a
 * recurring run, an imported invoice, a suggestion): how the NEXT order for this customer would change hands. It goes
 * through the ONE fulfil-path resolver over the tenant's stored `fulfilment_model` and the customer's stored path
 * (pickup-only: PICKUP; pickup+ship: the stored SHIP, else PICKUP; delivery / ship / unset: the customer's path), so a
 * pickup business is judged on the STORE's state, never on an address the customer may not even have.
 */
export async function defaultSaleFulfilmentKind(
  prisma: Pick<PrismaService, "tenantFeatureConfig" | "forTenant">,
  tenantId: string,
  customerId: string | null | undefined,
): Promise<SaleFulfilmentKind> {
  const customer = customerId
    ? await prisma.forTenant().customer.findFirst({
        where: { id: customerId },
        select: { fulfillPath: true },
      })
    : null;
  const fulfillPath = await resolveFulfilPath(
    {
      featureConfig: { getEffectiveMode: () => storedFulfilmentMode(prisma, tenantId) },
      tenantId,
    },
    { stored: customer?.fulfillPath, audience: "staff", role: null },
  );
  return saleFulfilmentKind({ counterSale: false, fulfillPath });
}
