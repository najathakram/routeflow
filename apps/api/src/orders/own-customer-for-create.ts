import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * OrdersService.create's "customer creates their own order" branch, moved verbatim (size ratchet, SA-1124 PR-1a).
 *
 * Returns the caller's own customer id. Refuses a route run/stop link before any read or write, and a customer
 * record that is missing or removed (403 CUSTOMER_NOT_LINKED).
 */
export async function resolveOwnCustomerForCreate(
  prisma: PrismaService,
  dto: { routeRunId?: string | null; routeRunStopId?: string | null },
  user: Pick<JwtPayload, "sub">,
): Promise<string> {
  // B309 (Opus MAJOR): the routeRunId/routeRunStopId link block later in
  // create() is role-agnostic and the controller admits CUSTOMER — without
  // this a buyer could POST either field directly and attach their own
  // order to a driver's manifest, bypassing the DRIVER-only
  // ownership/in-progress checks in create()'s DRIVER branch entirely. Refuse
  // before any read or write; the OPERATOR/TENANT_ADMIN path is untouched.
  if (dto.routeRunId || dto.routeRunStopId) {
    throw new BadRequestException("Route run linkage is not allowed for customer orders");
  }
  // REG-B131: `deletedAt: null` here, not a second check below — a removal deactivates the
  // user but an access token minted just before it stays valid for up to 15 minutes, so a
  // removed customer's own in-flight session must fall into the existing refusal.
  const customer = await prisma
    .forTenant()
    .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
  if (!customer)
    throw new ForbiddenException({
      code: API_ERROR_CODES.CUSTOMER_NOT_LINKED,
      message: "Customer record not found",
    });
  return customer.id;
}
