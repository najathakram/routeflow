import type { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { assertOrderEditNotLocked } from "../regulated/filing-lock";

/**
 * B297 PR5 (D4a), SA-819 MUST 4: the order-edit filing-lock gate. `updateOrderItems` calls it after the
 * revision check, so an editor on an outdated order meets the 409 for the stale revision first.
 * The guard asks the service's own replace predicate (role + diff shape), so an `items: []` buyer / driver
 * replace, which still runs deleteMany, is judged as the money-bearing edit it is.
 */
export function assertOrderEditFilingOpen(
  prisma: PrismaService,
  orderId: string,
  dto: unknown,
  user: JwtPayload | undefined,
): Promise<void> {
  return assertOrderEditNotLocked(
    prisma.forTenant(),
    orderId,
    dto as Parameters<typeof assertOrderEditNotLocked>[2],
    {
      tenantId: (user?.tenantId ?? prisma.getTenantId()) as string,
      role: user?.role,
    },
  );
}
