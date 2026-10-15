import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { NoImpersonation } from "../auth/decorators/no-impersonation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { SubscriptionService } from "./subscription.service";
import { INTERACTIVE_STRIPE_REQUEST, trimBillingViewForRole } from "./subscription-billing-extras";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingService } from "./billing.service";
import { QuoteDto } from "./dto/quote.dto";
import { SubscribeDto, UpgradeDto, DowngradeDto, EnableAddonDto } from "./dto/mutation.dto";
import {
  inviteOnlyCheckoutAllowed,
  INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
} from "./plan-catalog.constants";

interface AuthUser {
  tenantId: string | null;
  sub?: string;
}

/**
 * Tenant self-service billing (settings-billing + choose-plan). Authenticated
 * operators/admins only. Reads + quotes + the subscribe/upgrade/downgrade/cancel and
 * add-on enable/disable mutations. (Public pricing lives on GET /billing/plans.)
 *
 * SA-778: every mutating route except `quote` (read-like, no state change) carries
 * `@NoImpersonation("billing")`, so a support session can see these pages but not act on them.
 * billing-support-session.pin.spec.ts fails the build when a new mutation lacks it.
 */
@ApiTags("billing")
@ApiBearerAuth()
@Controller("billing")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class SettingsBillingController {
  constructor(
    private readonly subscription: SubscriptionService,
    private readonly proration: ProrationService,
    private readonly mutations: SubscriptionMutationService,
    private readonly billing: BillingService,
  ) {}

  /**
   * These are TENANT self-service views. A platform SUPER_ADMIN satisfies
   * @Roles(OPERATOR) via the role hierarchy but carries no tenant context — reject
   * it explicitly rather than laundering a null tenantId into the query layer (500).
   */
  private tenantIdOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException("This billing view requires a tenant context.");
    }
    return user.tenantId;
  }

  @Get("subscription")
  @ApiOperation({ summary: "The tenant's current plan, add-ons and renewal state" })
  async getSubscription(@CurrentUser() user: AuthUser & { role?: string }) {
    // S3: the card, the next charge and the amount are a workspace admin's; an operator keeps the contact's e-mail (who to ask) and the owed marker only.
    const view = await this.subscription.getSubscription(this.tenantIdOf(user));
    return trimBillingViewForRole(view, user.role);
  }

  @Get("usage")
  @ApiOperation({ summary: "Current-cycle meter usage (seats/routes/scans/msgs)" })
  getUsage(@CurrentUser() user: AuthUser) {
    return this.subscription.getUsage(this.tenantIdOf(user));
  }

  @Get("recommendation")
  @ApiOperation({ summary: "Usage-fit plan recommendation for choose-plan" })
  getRecommendation(@CurrentUser() user: AuthUser) {
    return this.subscription.getRecommendation(this.tenantIdOf(user));
  }

  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Price a plan + add-on selection at a cycle (choose-plan)" })
  async quote(@CurrentUser() user: AuthUser, @Body() dto: QuoteDto) {
    // No role gate here beyond the class-level @Roles(OPERATOR): a SUPER_ADMIN satisfies that
    // via the role hierarchy but carries no tenant context, so the plan-change preview is
    // simply skipped (`change: null`) rather than 403ing a legitimate quote read.
    const quote = await this.proration.quote(dto);
    const change = user.tenantId
      ? await this.mutations.planChangePreview(user.tenantId, dto.planKey, dto.cycle)
      : null;
    return { ...quote, change };
  }

  @Get("proration-preview")
  @ApiOperation({ summary: "Mid-cycle prorated charge to enable an add-on today" })
  async prorationPreview(@CurrentUser() user: AuthUser, @Query("sku") sku: string) {
    const tenantId = this.tenantIdOf(user);
    // `proratedToday` is an ESTIMATE: Stripe's own proration (returned by the enable call) is the
    // authoritative figure. The preview must agree with what enable will DO:
    //  - refused (annual subscription / the plan already includes the add-on): `billing: "REFUSED"`,
    //    `billed: false`, no charge figure, and `refusal` = the SAME `{ code, message }` enable throws;
    //  - UNBILLED (free pilot / Stripe not configured): the add-on is included at no charge, so
    //    there is NO `proratedToday` (null), and the UI must not promise a charge.
    // SA-690: `trial` is true while the tenant's status is TRIAL — the add-on is then on at no
    // charge now and is billed on the card checkout, so the confirm sheet says that instead of a charge.
    const [preview, billing, refusal, trial] = await Promise.all([
      this.proration.prorationPreview(tenantId, sku),
      this.mutations.addonBillingMode(tenantId),
      this.mutations.addonEnableRefusal(tenantId, sku),
      this.mutations.isTrialTenant(tenantId),
    ]);
    if (refusal) {
      return {
        ...preview,
        proratedToday: null,
        billing: "REFUSED",
        billed: false,
        refusal,
        trial,
      };
    }
    // `billing`: STRIPE (card, prorated) | MANUAL (appears on the owner's next invoice) | UNBILLED
    // (free pilot). `billed` is kept for clients that only need "does this cost money".
    const billed = billing !== "UNBILLED";
    return {
      ...preview,
      proratedToday: billed ? preview.proratedToday : null,
      billing,
      billed,
      refusal: null,
      trial,
    };
  }

  @Get("export")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Export billing data (works while READ_ONLY)" })
  export(@CurrentUser() user: AuthUser) {
    return this.subscription.getExport(this.tenantIdOf(user));
  }

  // ─── Mutations (money-moving — TENANT_ADMIN only, not plain OPERATOR) ────────

  @Post("subscribe")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Commit a subscription / convert a trial by picking a plan" })
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.mutations.subscribe(this.tenantIdOf(user), dto, user.sub);
  }

  @Post("subscription")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Upgrade to a higher plan (instant + prorated)" })
  upgrade(@CurrentUser() user: AuthUser, @Body() dto: UpgradeDto) {
    return this.mutations.upgrade(this.tenantIdOf(user), dto.planKey, user.sub);
  }

  @Post("subscription/downgrade")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Schedule a downgrade at period end (nothing deleted)" })
  downgrade(@CurrentUser() user: AuthUser, @Body() dto: DowngradeDto) {
    return this.mutations.downgrade(
      this.tenantIdOf(user),
      dto.targetPlanKey,
      dto.retainedUserIds ?? [],
      user.sub,
    );
  }

  @Post("subscription/cancel")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Schedule cancellation at period end" })
  cancel(@CurrentUser() user: AuthUser) {
    return this.mutations.cancel(this.tenantIdOf(user), user.sub);
  }

  @Post("subscription/resume")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Undo a scheduled cancellation" })
  resume(@CurrentUser() user: AuthUser) {
    return this.mutations.resume(this.tenantIdOf(user), user.sub);
  }

  /**
   * R2.9: a Stripe Checkout session for the tenant's OWN pinned plan/price — e.g. an
   * invited LITE tenant completing its first payment (see SubscriptionService.getSubscription's
   * `paymentRequired`). DELIBERATELY takes no request body: accepting a planKey here would let
   * a caller check out into an arbitrary plan, defeating the invite-only structural guarantee.
   * Switching plans still goes through subscribe/upgrade/downgrade above.
   */
  @Post("subscription/checkout")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Start a Stripe Checkout session for the tenant's own pinned plan" })
  async createCheckout(@CurrentUser() user: AuthUser) {
    const tenantId = this.tenantIdOf(user);
    const { planKey } = await this.subscription.getSubscription(tenantId);
    if (!inviteOnlyCheckoutAllowed(planKey, INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT)) {
      throw new ForbiddenException(
        "Self-serve checkout is currently disabled for this plan — contact us to complete your subscription.",
      );
    }
    const base = process.env.FRONTEND_URL ?? "http://localhost:3001";
    return this.billing.createCheckoutSession(tenantId, {
      successUrl: `${base}/settings/billing?checkout=success`,
      cancelUrl: `${base}/settings/billing?checkout=cancelled`,
    });
  }

  /**
   * SA-733r6 (B4): the Stripe billing portal (update the card) plus, while an invoice is owed, its hosted page (pay it).
   * TENANT_ADMIN only - an operator is told who to ask and gets no action. The read-only guard allow-lists this exact
   * route so an admin can always reach Stripe from a paused workspace.
   */
  @Post("portal")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Stripe billing portal + the owed invoice's hosted page (admin only)" })
  async createPortal(@CurrentUser() user: AuthUser) {
    const tenantId = this.tenantIdOf(user);
    // allSettled: a failure of one Stripe call must not lose the other (the pay link survives a portal outage and
    // vice versa). Both are capped (#2476) so the route never hangs on Stripe.
    const [portal, pay] = await Promise.allSettled([
      this.billing.createBillingPortalSession(tenantId, undefined, INTERACTIVE_STRIPE_REQUEST),
      this.subscription.openInvoiceUrl(tenantId),
    ]);
    const portalUrl = portal.status === "fulfilled" ? portal.value.portalUrl : null;
    const hostedInvoiceUrl = pay.status === "fulfilled" ? pay.value : null;
    if (portalUrl || hostedInvoiceUrl) return { portalUrl, hostedInvoiceUrl };
    // Neither is available. A workspace with no Stripe customer (manual / external payment) is a clean 400; a Stripe
    // outage is a retryable 503. Both coded, never a bare 500.
    if (portal.status === "rejected" && portal.reason instanceof BadRequestException) {
      throw new BadRequestException({
        code: API_ERROR_CODES.BILLING_PORTAL_UNAVAILABLE,
        message: "Billing isn't set up online for this workspace.",
      });
    }
    throw new ServiceUnavailableException({
      code: API_ERROR_CODES.BILLING_PORTAL_UNAVAILABLE,
      message: "We couldn't open billing just now. Please try again in a moment.",
    });
  }

  @Post("addons/:sku/enable")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Enable an add-on (prorated for the current cycle)" })
  enableAddon(
    @CurrentUser() user: AuthUser,
    @Param("sku") sku: string,
    @Body() dto: EnableAddonDto,
  ) {
    return this.mutations.enableAddon(
      this.tenantIdOf(user),
      sku,
      dto.quantity,
      user.sub,
      dto.expectedQuantity,
    );
  }

  @Post("addons/:sku/disable")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({ summary: "Disable an add-on (history kept read-only)" })
  disableAddon(@CurrentUser() user: AuthUser, @Param("sku") sku: string) {
    return this.mutations.disableAddon(this.tenantIdOf(user), sku, user.sub);
  }
}
