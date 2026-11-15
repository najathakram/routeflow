import { Injectable, Logger } from "@nestjs/common";
import type { BillingStatusView } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { resolveZone } from "../common/tenant-time-zone";
import { SubscriptionService } from "./subscription.service";
import { seesBillingMoney } from "./subscription-billing-extras";
import { PaymentDueService } from "./payment-due.service";
import { billingStatusOf, hasStaleDunningMarker, hasTwoPaySources } from "./billing-status";

/** The warn-once sets are bounded like the existing caches: past this the OLDEST tenant is forgotten (it may warn again). */
export const WARNED_TENANTS_CAP = 5000;

/**
 * SA-1146 B-5: assembles the inputs of the pure `billingStatusOf` (the FULL subscription view, the payment-due view,
 * the tenant's zone, the role) and calls it. The controller (B-5) and the platform-admin read (B-6) both come here,
 * so the role rule lives in exactly one place: `seesBillingMoney` (the same predicate as `trimBillingViewForRole`),
 * then `billingStatusOf` projects the view for staff. Trimming further fields by role is one function: `forRole`.
 */
@Injectable()
export class BillingStatusService {
  private readonly logger = new Logger(BillingStatusService.name);
  private readonly warnedTenants = new Set<string>();
  private readonly warnedStale = new Set<string>();

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
    // applied by `billingStatusOf`, so no amount is read from a trimmed copy.
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
      isAdmin: seesBillingMoney(role),
    };
    if (hasTwoPaySources(input) && this.firstWarn(this.warnedTenants, tenantId)) {
      // Mutually exclusive by construction (catch-up refuses a business with a Stripe subscription).
      this.logger.warn(
        `Tenant ${tenantId} has both a Stripe invoice and a catch-up bill; showing the invoice.`,
      );
    }
    if (hasStaleDunningMarker(input) && this.firstWarn(this.warnedStale, tenantId)) {
      // The marker lags `invoice.paid`: Stripe already says current, so the view says nothing (never failed, never paid up).
      this.logger.warn(
        `Tenant ${tenantId} has a dunning marker but Stripe says current; showing none.`,
      );
    }
    return this.forRole(billingStatusOf(input));
  }

  /** True the first time `tenantId` is seen in `seen`; the set never grows past WARNED_TENANTS_CAP. */
  private firstWarn(seen: Set<string>, tenantId: string): boolean {
    if (seen.has(tenantId)) return false;
    if (seen.size >= WARNED_TENANTS_CAP) seen.delete(seen.values().next().value as string);
    seen.add(tenantId);
    return true;
  }

  /** The one place a role trims the view further. `billingStatusOf` already projects staff; nothing else today. */
  private forRole(view: BillingStatusView): BillingStatusView {
    return view;
  }
}
