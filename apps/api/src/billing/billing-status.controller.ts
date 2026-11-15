import { Controller, ForbiddenException, Get, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { BillingStatusView } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PermissionBase } from "../auth/permissions/permission.decorators";
import { BillingStatusService } from "./billing-status.service";

interface AuthUser {
  tenantId: string | null;
  role?: string;
}

/**
 * SA-1146 B-5: `GET /billing/status`, the one status every billing surface renders. OPERATOR and up may read it (staff
 * see the sentence); the `action` is the server's decision and is set for a TENANT_ADMIN (or SUPER_ADMIN in a tenant)
 * only. The tenant id and the role are the JWT's; the route takes no id, amount or role from the request. Read-only:
 * no money moves here. The assembly lives in `BillingStatusService`.
 */
@ApiTags("billing")
@ApiBearerAuth()
@Controller("billing/status")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class BillingStatusController {
  constructor(private readonly status: BillingStatusService) {}

  @PermissionBase("cross-cutting lookup other areas need (spec-operator-permissions §4.3)")
  @Get()
  @ApiOperation({ summary: "The one billing status: what is owed, and the admin's single action" })
  async get(@CurrentUser() user: AuthUser): Promise<BillingStatusView> {
    if (!user.tenantId) {
      throw new ForbiddenException("This billing view requires a tenant context.");
    }
    return this.status.get(user.tenantId, user.role);
  }
}
