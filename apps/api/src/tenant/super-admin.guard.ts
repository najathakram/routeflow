import { Injectable, CanActivate, ExecutionContext } from "@nestjs/common";
import { UserRole } from "@prisma/client";

/**
 * Guard that allows only SUPER_ADMIN users.
 * Applied to all /platform-admin/* routes.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    return user?.role === UserRole.SUPER_ADMIN;
  }
}
