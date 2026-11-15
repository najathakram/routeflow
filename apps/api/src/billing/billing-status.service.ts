import { Injectable, Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { BillingStatusView } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { resolveZone } from "../common/tenant-time-zone";
import { SubscriptionService } from "./subscription.service";
import { PaymentDueService } from "./payment-due.service";
import { billingStatusOf, hasTwoPaySources } from "./billing-status";

/**
 * SA-1146 B-5: assembles the inputs of the pure `billingStatusOf` (the FULL subscription view, the payment-due view,
 * the tenant's zone, the role) and calls it. The controller (B-5) and the platform-admin read (B-6) both come here,
 * so the role rule lives in exactly one place: `isAdminRole`, then `billingStatusOf` nulls `action` for staff.
 * Trimming further fields by role (the SA-777 question) is one function to change: `forRole` below.
 */
@Injectable()
export class BillingStatusService {
  private readonly logger = new Logger(BillingStatusService.name);
  private readonly warnedTenants = new Set<string>();

  constructor(
    private readonly subscription: SubscriptionService,
    private readonly paymentDue: PaymentDueService,
    private readonly prisma: PrismaService,
  ) {}

  /** The status for `tenantId` as seen by `role`. The caller has already refused a request with no tenant. */
  async get(
    tenantId: string,
    role: string | undefined,
    now = new Date(),
  ): Promise<BillingStatusView> {
    // The FULL subscription view (an operator's trimmed one omits the amounts the sentence names); the role rule is
    // applied by `forRole`, so no amount is read from a trimmed copy.
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
      isAdmin: isAdminRole(role),
    };
    if (hasTwoPaySources(input) && !this.warnedTenants.has(tenantId)) {
      this.warnedTenants.add(tenantId);
      // Mutually exclusive by construction (catch-up refuses a business with a Stripe subscription).
      this.logger.warn(
        `Tenant ${tenantId} has both a Stripe invoice and a catch-up bill; showing the invoice.`,
      );
    }
    return this.forRole(billingStatusOf(input));
  }

  /** The one place a role trims the view. Today `billingStatusOf` already nulls `action` for staff; nothing else. */
  private forRole(view: BillingStatusView): BillingStatusView {
    return view;
  }
}

/** TENANT_ADMIN, and SUPER_ADMIN acting in a tenant (the same rule as `trimBillingViewForRole`). */
export function isAdminRole(role: string | undefined): boolean {
  return role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN;
}
