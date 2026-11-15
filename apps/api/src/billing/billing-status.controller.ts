import { Controller, ForbiddenException, Get, Logger, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { BillingStatusView } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PermissionBase } from "../auth/permissions/permission.decorators";
import { PrismaService } from "../prisma/prisma.service";
import { resolveZone } from "../common/tenant-time-zone";
import { SubscriptionService } from "./subscription.service";
import { PaymentDueService } from "./payment-due.service";
import { billingStatusOf, hasTwoPaySources } from "./billing-status";

interface AuthUser {
  tenantId: string | null;
  role?: string;
}

/**
 * SA-1146 B-5: `GET /billing/status`, the one status every billing surface renders. OPERATOR and up may read it (staff
 * see the sentence); the `action` is the server's decision and is set for a TENANT_ADMIN only. The tenant id and the
 * role are the JWT's; the route takes no id, amount or role from the request. Read-only: no money moves here.
 */
@ApiTags("billing")
@ApiBearerAuth()
@Controller("billing/status")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class BillingStatusController {
  private readonly logger = new Logger(BillingStatusController.name);
  private readonly warnedTenants = new Set<string>();

  constructor(
    private readonly subscription: SubscriptionService,
    private readonly paymentDue: PaymentDueService,
    private readonly prisma: PrismaService,
  ) {}

  @PermissionBase("cross-cutting lookup other areas need (spec-operator-permissions §4.3)")
  @Get()
  @ApiOperation({ summary: "The one billing status: what is owed, and the admin's single action" })
  async get(@CurrentUser() user: AuthUser): Promise<BillingStatusView> {
    if (!user.tenantId) {
      throw new ForbiddenException("This billing view requires a tenant context.");
    }
    const tenantId = user.tenantId;
    const now = new Date();
    // The FULL subscription view (an operator's trimmed one omits the amounts the sentence names); the role rule is
    // applied below, by `billingStatusOf`, so no amount is read from a trimmed copy.
    const [subscription, paymentDue, zone] = await Promise.all([
      this.subscription.getSubscription(tenantId),
      this.paymentDue.get(tenantId, now),
      resolveZone(this.prisma, { tenantId }),
    ]);
    const input = {
      subscription,
      paymentDue,
      now,
      timeZone: zone.zone,
      isAdmin: user.role === UserRole.TENANT_ADMIN || user.role === UserRole.SUPER_ADMIN,
    };
    if (hasTwoPaySources(input) && !this.warnedTenants.has(tenantId)) {
      this.warnedTenants.add(tenantId);
      // Mutually exclusive by construction (catch-up refuses a business with a Stripe subscription).
      this.logger.warn(
        `Tenant ${tenantId} has both a Stripe invoice and a catch-up bill; showing the invoice.`,
      );
    }
    return billingStatusOf(input);
  }
}
