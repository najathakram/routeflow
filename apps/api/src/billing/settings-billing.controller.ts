import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { SubscriptionService } from "./subscription.service";
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
  getSubscription(@CurrentUser() user: AuthUser) {
    return this.subscription.getSubscription(this.tenantIdOf(user));
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
  prorationPreview(@CurrentUser() user: AuthUser, @Query("sku") sku: string) {
    return this.proration.prorationPreview(this.tenantIdOf(user), sku);
  }

  @Get("export")
  @ApiOperation({ summary: "Export billing data (works while READ_ONLY)" })
  export(@CurrentUser() user: AuthUser) {
    return this.subscription.getExport(this.tenantIdOf(user));
  }

  // ─── Mutations (money-moving — TENANT_ADMIN only, not plain OPERATOR) ────────

  @Post("subscribe")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Commit a subscription / convert a trial by picking a plan" })
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.mutations.subscribe(this.tenantIdOf(user), dto, user.sub);
  }

  @Post("subscription")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Upgrade to a higher plan (instant + prorated)" })
  upgrade(@CurrentUser() user: AuthUser, @Body() dto: UpgradeDto) {
    return this.mutations.upgrade(this.tenantIdOf(user), dto.planKey, user.sub);
  }

  @Post("subscription/downgrade")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
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
  @ApiOperation({ summary: "Schedule cancellation at period end" })
  cancel(@CurrentUser() user: AuthUser) {
    return this.mutations.cancel(this.tenantIdOf(user), user.sub);
  }

  @Post("subscription/resume")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
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

  @Post("addons/:sku/enable")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Enable an add-on (prorated for the current cycle)" })
  enableAddon(
    @CurrentUser() user: AuthUser,
    @Param("sku") sku: string,
    @Body() dto: EnableAddonDto,
  ) {
    return this.mutations.enableAddon(this.tenantIdOf(user), sku, dto.quantity, user.sub);
  }

  @Post("addons/:sku/disable")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Disable an add-on (history kept read-only)" })
  disableAddon(@CurrentUser() user: AuthUser, @Param("sku") sku: string) {
    return this.mutations.disableAddon(this.tenantIdOf(user), sku, user.sub);
  }
}
