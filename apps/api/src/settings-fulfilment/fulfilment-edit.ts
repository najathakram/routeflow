import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * THE one "may this user change the fulfilment settings" predicate. The edit routes' guard and GET's
 * `canEdit` both read it, so the screen can never offer a change the server would refuse (or the
 * reverse). TENANT_ADMIN only for now; SUPER_ADMIN satisfies it the way it satisfies every role
 * (and still needs a tenant context, which the service enforces).
 */
export function canEditFulfilment(user: Pick<JwtPayload, "role"> | null | undefined): boolean {
  const role = user?.role as string | undefined;
  return role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN;
}

/** Guard form of {@link canEditFulfilment}, stacked behind `@Roles(TENANT_ADMIN)` on preview and change. */
@Injectable()
export class FulfilmentEditGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    return canEditFulfilment(user);
  }
}
