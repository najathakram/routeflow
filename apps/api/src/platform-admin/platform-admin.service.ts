import {
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  BadGatewayException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { TenantStatus, TenantPlan, Prisma, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { PlatformPricingService } from "../billing/platform-pricing.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ProrationService } from "../billing/proration.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { MeterService } from "../billing/meter.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanTransitionConfigService } from "../billing/plan-transition-config.service";
import { gateVia } from "../billing/feature-registry";
import { BillingEventService } from "../billing/billing-event.service";
import { MrrService, isPayingRow } from "../billing/mrr.service";
import { TenantMirrorService } from "./tenant-mirror.service";
import {
  LEGACY_PLAN_KEY_ALIASES,
  normalizePlanKey,
  planKeyFromEnum,
  SELECTABLE_TENANT_PLANS,
  findPlanDefinition,
  planRank,
  BILLING_EVENTS,
  TRIAL_LENGTH_DAYS,
  isInviteOnlyPlanKey,
  INVITE_ONLY_PLAN_TRIAL_DAYS,
  inviteOnlyCheckoutAllowed,
  addonSkuCode,
} from "../billing/plan-catalog.constants";
import { bookAddonsOnCrossing, lockTenantForLedger } from "../billing/addon-ledger";
import { billableAddonWhere } from "../billing/addon-row";
import {
  priceUnbilledAddonsOnActivation,
  unbilledSelfServeSkus,
  withAddonLocks,
} from "../billing/manual-activation-addons";
import { roundMoney } from "@routeflow/pricing";
import { StripeService } from "../billing/stripe.service";
import { ScheduledPriceChangeService } from "../billing/scheduled-price-change";
import {
  beginStripeFirstPlanChange,
  PLAN_CHANGE_LANDED,
  planChangeArgs,
} from "../billing/plan-change-flow";
import { manualPayContext } from "../billing/addon-retirement";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AppConfig } from "../config/configuration";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { classifyTenantSlug } from "../tenant/tenant-class";
import { isApprovedTestTenantSlug } from "../common/tenant-class.util";
import { CreateTenantAdminDto } from "./dto/create-tenant-admin.dto";
import { IRS_SYSTEM_CATEGORIES } from "../bookkeeping/irs-categories.constant";
import { ActivateSubscriptionDto } from "./dto/activate-subscription.dto";
import { UpdateTenantConfigDto } from "./dto/update-tenant-config.dto";
import { UpdateTenantPriceDto } from "./dto/update-tenant-price.dto";
import { UpdatePlanPricesDto } from "./dto/update-plan-prices.dto";
import { UpdateTenantClassDto } from "./dto/update-tenant-class.dto";
import { AuditService } from "../audit/audit.service";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY,
  ADMIN_AUDIT_ACTION_FACETS,
  adminAuditActionLabel,
  type AdminAuditActionCode,
} from "./audit-actions.constant";
import { escapeHtml } from "../common/html-escape";
import {
  CUSTOM_FEE_UNCHANGED,
  isPricePushFailure,
  mergeOverride,
  priceOverrideAudit,
  priceOverrideOf,
  sameOverride,
  type PriceOverrideEffective,
  type PricePushResult,
  type ProposedOverride,
} from "../billing/price-override";
import { underTenantPriceLock } from "../billing/price-lock";
import { issueSetPasswordLink } from "../users/set-password-token";
import { assertSafeTextCell } from "../common/safe-text-cell";
import { assertValidTenantTimeZone } from "../system-config/tenant-timezone.writer";
import { STAFF_ACCESS_AUDIENCE } from "../auth/session-token";

/** 409 TENANT_TRIAL_EXTEND_NOT_ALLOWED: an ACTIVE tenant is never moved to TRIAL. */
function activeTenantTrialRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.TENANT_TRIAL_EXTEND_NOT_ALLOWED,
    message: "This tenant is Active. A trial can't be set on a paying tenant.",
  });
}

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig>,
    private readonly emailService: EmailService,
    private readonly billingService: BillingService,
    private readonly platformPricingService: PlatformPricingService,
    private readonly planCatalogService: PlanCatalogService,
    private readonly proration: ProrationService,
    private readonly entitlementsService: EntitlementsService,
    private readonly billingEventService: BillingEventService,
    private readonly meterService: MeterService,
    private readonly tenantStatusGuard: TenantStatusGuard,
    private readonly auditService: AuditService,
    private readonly mrrService: MrrService,
    private readonly tenantMirror: TenantMirrorService,
    private readonly featureOverrides: FeatureOverrideService,
    // Lane B A2b: downgrade -> snapshot the tenant's feature config, upgrade -> restore it, in
    // the same transaction as the plan write (live flag entitlements.configSnapshot, default off).
    private readonly planTransition: PlanTransitionConfigService,
    // SA-733r M7: the Stripe-first plan-change push.
    private readonly stripe: StripeService,
    // R1 Option B: undoes an early downgrade price push before an admin plan change prorates from it.
    @Optional() private readonly scheduledPrice?: ScheduledPriceChangeService,
  ) {}

  /**
   * Emit a purpose-built audit row keyed to the TARGET tenant so a platform-admin
   * action surfaces when the audit log is filtered by that tenant. The generic
   * AuditInterceptor also records the request, but with tenantId=null and a
   * useless entityId, so it never appears in per-tenant views — this row does.
   * Fire-and-forget: AuditService.log swallows its own errors, so a logging
   * failure never breaks the mutation.
   */
  async recordAdminAction(
    // Nullable for platform-global actions with no single tenant (feature grants v2 brief A:
    // the entitlements.mode switch and diff-explain actions apply platform-wide) — AuditService
    // itself already accepts `tenantId: string | null`; every existing call site still passes a
    // real tenant id unchanged.
    tenantId: string | null,
    adminId: string | null,
    action: AdminAuditActionCode,
    meta?: Record<string, unknown>,
  ) {
    await this.auditService.log({
      tenantId,
      userId: adminId,
      action,
      entityType: ADMIN_AUDIT_ENTITY,
      entityId: tenantId,
      meta: { platformAdmin: true, ...(meta ?? {}) },
    });
  }

  // ─── Tenant list ─────────────────────────────────────────────────────────────

  async listTenants(
    page = 1,
    limit = 20,
    filters: {
      search?: string | null;
      status?: string | null;
      plan?: string | null;
      sortKey?: string | null;
      sortDir?: "asc" | "desc" | null;
      includeDeleted?: boolean;
    } = {},
  ) {
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    // Cancelled/soft-deleted tenants are hidden unless explicitly requested.
    if (!filters.includeDeleted) where.deletedAt = null;
    if (filters.status) where.status = filters.status;
    if (filters.plan) {
      // SA-1: filter by the REAL billing plan (subscription.planKey) — the one every list row
      // displays — not the legacy Tenant.plan enum, which drifts (B556). A tenant with no
      // resolved planKey is shown under planKeyFromEnum(plan), so it is matched the same way.
      const legacyPlans = SELECTABLE_TENANT_PLANS.filter(
        (p) => planKeyFromEnum(p) === filters.plan,
      );
      const storedKeys = [
        filters.plan,
        ...Object.entries(LEGACY_PLAN_KEY_ALIASES)
          .filter(([, current]) => current === filters.plan)
          .map(([legacy]) => legacy),
      ];
      where.AND = [
        {
          OR: [
            // every stored key the row would normalize to this plan (a legacy alias shows as its current plan)
            { subscription: { planKey: { in: storedKeys } } },
            {
              AND: [
                { OR: [{ subscription: null }, { subscription: { planKey: null } }] },
                { plan: { in: legacyPlans } },
              ],
            },
          ],
        },
      ];
    }
    if (filters.search) {
      const q = filters.search.trim();
      where.OR = [
        { slug: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { config: { businessName: { contains: q, mode: "insensitive" } } },
      ];
    }

    const dir: "asc" | "desc" = filters.sortDir === "asc" ? "asc" : "desc";
    let orderBy: Record<string, unknown>;
    switch (filters.sortKey) {
      case "slug":
        orderBy = { slug: dir };
        break;
      case "name":
        orderBy = { name: dir };
        break;
      case "status":
        orderBy = { status: dir };
        break;
      case "plan":
        orderBy = { plan: dir };
        break;
      case "users":
        orderBy = { users: { _count: dir } };
        break;
      default:
        orderBy = { createdAt: dir };
    }

    const [tenants, total, deletedCount] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          config: {
            select: { businessName: true, primaryColor: true, logoKey: true },
          },
          subscription: {
            // planKey added (SA-140/B556) — _formatTenant()'s planKey field needs it; this
            // select previously omitted it, so every list row silently fell back to the legacy
            // Tenant.plan enum (L-169).
            select: { currentPlan: true, periodEnd: true, cancelAtPeriodEnd: true, planKey: true },
          },
          _count: {
            select: { users: true, customers: true, orders: true },
          },
        },
      }),
      this.prisma.tenant.count({ where }),
      // Total soft-deleted tenants, independent of the current filter, so the
      // "Show deleted (N)" affordance has a real count even when they're hidden.
      this.prisma.tenant.count({ where: { deletedAt: { not: null } } }),
    ]);

    return {
      data: tenants.map((t) => this._formatTenant(t)),
      meta: { total, page, limit, pages: Math.ceil(total / limit), deletedCount },
    };
  }

  async getTenant(id: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // REG-743-N1 (L-119): priced through MrrService.priceTenant() — the SAME function
    // computeOverview() sums for the platform-wide dashboard — instead of the retired
    // catalog-fallback estimator. priceTenant() applies its own class/status/planKey gate,
    // so this call site no longer branches on tenant.status itself.
    const [tenant, orders30d, estMrrUsd] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id },
        include: {
          config: true,
          subscription: true,
          _count: {
            select: {
              users: true,
              customers: true,
              orders: true,
              drivers: true,
              routes: true,
              customerLinks: true,
              // SA-3: the Readiness card's "Has at least one product" row (tenant-scoped relation count).
              // Active products only: a tenant whose products are all inactive has nothing to sell.
              products: { where: { isActive: true } },
            },
          },
        },
      }),
      // Read-only order count (orders module untouched); raw client is correct
      // here since a super-admin request carries no tenant scope.
      this.prisma.order.count({ where: { tenantId: id, createdAt: { gte: thirtyDaysAgo } } }),
      this.mrrService.priceTenant(id),
    ]);
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return {
      ...this._formatTenant(tenant),
      orders30d,
      estMrrUsd,
    };
  }

  /**
   * WP1 (R1.8) shared guard: resolve `planKey` against the currently PUBLISHED plan catalog,
   * throwing loudly instead of letting a caller fall through to compute()'s silent STARTER
   * fallback. Every write that sets a tenant onto a specific plan must call this and persist
   * BOTH the returned definition's planKey and version.id together.
   */
  private async resolvePublishedPlan(planKey: string) {
    const version = await this.planCatalogService.getPublishedVersion();
    if (!version) {
      throw new BadRequestException(
        "No published plan catalog exists. Seed the billing catalog first.",
      );
    }
    const definition = findPlanDefinition(version.definitions, planKey);
    if (!definition) {
      throw new BadRequestException(
        `Plan "${planKey}" is not in the published plan catalog — publish it before assigning tenants to it.`,
      );
    }
    return { version, definition };
  }

  // ─── Create / Delete Tenant ───────────────────────────────────────────────────

  async createTenant(dto: CreateTenantDto, adminId: string | null = null) {
    const { slug, businessName, adminEmail, adminUsername, plan } = dto;
    assertSafeTextCell({ businessName }); // B956: the name is mirrored into a Customer row
    // SA-738 R16-4: the creation-time zone is REQUIRED (no silent New York default). The DTO refuses at
    // the pipe; this is the service backstop for non-HTTP callers (400 INVALID_TIME_ZONE, before any write).
    const timezone = assertValidTenantTimeZone(dto.timezone);

    const RESERVED_SLUGS = ["admin", "api", "app", "www", "platform", "auth", "health", "static"];
    if (RESERVED_SLUGS.includes(slug.toLowerCase()))
      throw new ConflictException(`Slug "${slug}" is reserved and cannot be used`);

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugTaken) throw new ConflictException(`Slug "${slug}" is already taken`);

    const planKey = plan ?? "STARTER";
    await this.resolvePublishedPlan(planKey); // R1.8: never the silent STARTER fallback in compute()
    if (dto.startMode === "trial" && dto.trialLengthDays == null) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.TENANT_TRIAL_DAYS_REQUIRED,
        message: "trialLengthDays is required when startMode is trial",
      });
    }
    const trialDays =
      dto.trialLengthDays ??
      (isInviteOnlyPlanKey(planKey) ? INVITE_ONLY_PLAN_TRIAL_DAYS : TRIAL_LENGTH_DAYS);

    // #2439: no password is ever generated or emailed. An admin-supplied password is kept (they
    // share it themselves); otherwise the account has NO password until the owner uses the
    // single-use set-password link in the welcome email (or Google sign-in).
    const hashedPassword = dto.adminPassword ? await bcrypt.hash(dto.adminPassword, 10) : null;
    // PLAN_KEYS values (STARTER/GROWTH/SCALE/ENTERPRISE) are a subset of the widened
    // TenantPlan enum with matching names (Phase 0 Task 1), so a validated key casts
    // directly — CreateTenantDto.plan is now @IsIn(PLAN_KEYS)-validated.
    const tenantPlan = (plan as TenantPlan) ?? TenantPlan.STARTER;
    const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

    // REG-743-F7: Tenant.class defaults to PRODUCTION at the schema level and was never set
    // explicitly here — fail-open onto PRODUCTION regardless of slug. Resolve from an explicit
    // caller-supplied class first, else derive it from the slug; fail CLOSED when the caller
    // asks for PRODUCTION on a slug the classifier itself would never call PRODUCTION (never
    // silently trust a caller-supplied class that contradicts the slug's own policy).
    const slugClass = classifyTenantSlug(slug);
    const resolvedClass = dto.class ?? slugClass;
    if (dto.class === "PRODUCTION" && slugClass !== "PRODUCTION") {
      throw new BadRequestException(
        `Slug "${slug}" classifies as ${slugClass} — cannot create it as class PRODUCTION`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: businessName,
          status: "TRIAL",
          plan: tenantPlan,
          class: resolvedClass,
          trialEndsAt,
        },
      });

      // B556: see TenantsService.register() for the full rationale — keep
      // TenantSubscription.planKey in lockstep with Tenant.plan from the moment of creation,
      // via the same total planKeyFromEnum() mapping, so this tenant can never become the
      // "real Tenant.plan, no resolved planKey" shape MrrService prices at $0 forever. No
      // basePriceSnapshot here — this tenant starts TRIAL and payingWhere already excludes it.
      await tx.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          currentPlan: tenantPlan,
          planKey: planKeyFromEnum(tenantPlan),
        },
      });

      await tx.tenantConfig.create({
        data: { tenantId: tenant.id, businessName, timezone },
      });

      await tx.expenseCategory.createMany({
        data: IRS_SYSTEM_CATEGORIES.map((c) => ({
          tenantId: tenant.id,
          name: c.name,
          code: c.code,
          isCustom: false,
        })),
        skipDuplicates: true,
      });

      const existingUser = await tx.user.findFirst({
        where: { tenantId: tenant.id, OR: [{ email: adminEmail }, { username: adminUsername }] },
      });
      if (existingUser) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.ACCOUNT_IDENTIFIER_IN_USE,
          message: "Email or username already in use",
        });
      }

      const user = await tx.user.create({
        data: {
          email: adminEmail,
          username: adminUsername,
          password: hashedPassword,
          role: "TENANT_ADMIN",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: tenant.id,
          // Owner decision 2026-08-28: admins are NOT drivers by default — driver capability
          // is an explicit opt-in via Settings → Act as driver
          // (users.service.toggleDriverPermit), which creates the Driver row on first enable.
          canActAsDriver: false,
        },
      });

      return { tenant, user };
    });

    // #2439: the welcome email — a single-use 72h set-password link (never a password), the
    // login URL, and a STABLE "Pay now" link (login → /settings/billing, whose checkout button
    // mints a fresh Stripe session via POST /settings/billing/subscription/checkout) when this
    // plan allows self-serve checkout (R2.7). No checkout session is created here any more: its
    // URL expired in 24h. Delivery is recorded on the audit row and returned.
    const webBase = (
      this.config.get<AppConfig["urls"]>("urls")?.web ?? "http://localhost:3001"
    ).replace(/\/+$/, "");
    const loginUrl = `${webBase}/login`;
    // Start active: the operator activates right after create (manual payment), so the welcome
    // email must not offer a card payment or say a trial is running.
    const payUrl =
      dto.startMode !== "active" && inviteOnlyCheckoutAllowed(planKey)
        ? `${webBase}/login?redirect=${encodeURIComponent("/settings/billing")}`
        : null;
    const welcomeEmail = await this.sendWelcomeEmail({
      userId: result.user.id,
      to: adminEmail,
      username: adminUsername,
      businessName,
      workspace: result.tenant.slug,
      webBase,
      loginUrl,
      payUrl,
      trialDays,
    });

    try {
      await this.tenantMirror.upsert(result.tenant.id);
    } catch (err) {
      this.logger.debug(`Mirror sync not created for ${slug}: ${(err as Error).message}`);
    }

    await this.recordAdminAction(result.tenant.id, adminId, AdminAuditAction.TENANT_CREATED, {
      slug: result.tenant.slug,
      plan: result.tenant.plan,
      class: result.tenant.class,
      adminUsername: result.user.username,
      welcomeEmail,
      timezone,
    });

    return {
      id: result.tenant.id,
      slug: result.tenant.slug,
      name: result.tenant.name,
      status: result.tenant.status,
      plan: result.tenant.plan,
      trialEndsAt: result.tenant.trialEndsAt,
      adminUserId: result.user.id,
      adminUsername: result.user.username,
      loginUrl,
      payUrl,
      welcomeEmail,
      // Row 195: a test-pattern slug is allowed here (super-admin intent) but is flagged, because the
      // tenant is classed TEST and every test-only script treats it as disposable.
      ...(isApprovedTestTenantSlug(slug.toLowerCase())
        ? { notice: "This will be a TEST tenant: its slug matches a test-tenant pattern." }
        : {}),
    };
  }

  /** #2439: never throws — tenant creation must not fail over email; the outcome is returned. */
  private async sendWelcomeEmail(p: {
    userId: string;
    to: string;
    username: string;
    businessName: string;
    workspace: string;
    webBase: string;
    loginUrl: string;
    payUrl: string | null;
    trialDays: number;
  }): Promise<{ to: string; delivered: boolean; transport: string; error?: string }> {
    // #2439 (Opus fold): in production a welcome email built on the localhost fallback would hand
    // the customer dead links. Don't send it (and don't mint a token for it) — report it as
    // undelivered so the admin UI's alert points at "Reset admin password".
    if (process.env.NODE_ENV === "production" && !isPublicWebBase(p.webBase)) {
      this.logger.error(
        `Welcome email NOT sent for tenant ${p.workspace}: WEB_URL is unset or points at localhost`,
      );
      return { to: p.to, delivered: false, transport: "none", error: "WEB_URL unset" };
    }
    try {
      const link = await issueSetPasswordLink(this.prisma, p.userId, p.webBase);
      const r = await this.emailService.sendTenantWelcomeEmail({
        to: p.to,
        username: p.username,
        businessName: p.businessName,
        workspace: p.workspace,
        setPasswordUrl: link.url,
        expiryHours: link.expiryHours,
        loginUrl: p.loginUrl,
        payUrl: p.payUrl,
        trialDays: p.trialDays,
      });
      if (!r.delivered) {
        this.logger.error(
          `Welcome email NOT delivered for tenant ${p.workspace}: transport=${r.transport} error=${r.error ?? "unknown"}`,
        );
      }
      return {
        to: p.to,
        delivered: r.delivered,
        transport: r.transport,
        ...(r.error ? { error: r.error } : {}),
      };
    } catch (err) {
      const error = (err as Error).message.slice(0, 200);
      this.logger.error(`Welcome email failed for tenant ${p.workspace}: ${error}`);
      return { to: p.to, delivered: false, transport: "none", error };
    }
  }

  async deleteTenant(id: string, adminId: string | null = null) {
    const existing = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, status: true },
    });
    if (!existing) throw new NotFoundException(`Tenant ${id} not found`);
    if (existing.status !== "SUSPENDED") {
      throw new BadRequestException(
        "Tenant must be suspended before it can be deleted. Suspend the tenant first.",
      );
    }
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: { deletedAt: new Date(), status: "CANCELLED" },
    });
    // Evict cached status so the guard blocks this tenant immediately
    this.tenantStatusGuard.invalidate(id);
    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_DELETED, {
      slug: tenant.slug,
    });
    return { id: tenant.id, slug: tenant.slug, status: tenant.status, deletedAt: tenant.deletedAt };
  }

  // ─── Mutations ────────────────────────────────────────────────────────────────

  async updateStatus(id: string, dto: UpdateTenantStatusDto, adminId: string | null = null) {
    await this._findOrThrow(id);

    // B216 / FINDING-3 (round 2 review): the prior-status read, the status write, and the
    // downgrade lookup are ONE transaction, using the same non-ACTIVE→ACTIVE CAS shape as
    // billing.service.ts's transitionAndEmit() (a conditional `updateMany` predicated on the
    // PRIOR status IS the "was this a REAL transition" read — count===1 only if THIS call
    // flipped the row). The old shape ran three separate, unserialized queries, so the schedule
    // this call reports could be one a concurrent downgrade() armed a moment later. One
    // transaction means the audit line describes the row as it stood at the transition.
    const { tenant, armedDowngrade } = await this.prisma.$transaction(async (tx) => {
      // SA-140: lock the row FIRST, before any read this transaction's decision depends on —
      // closes a race against a concurrent write to the SAME tenant from a different admin
      // action (updateTenantClass(), reconcilePriceLedger()'s snapshot update, etc.) that could
      // otherwise interleave with the read-then-decide logic below.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;

      // B556/B557: read the tenant's PRIOR paying-set inputs — status, class, deletedAt, and
      // its subscription's planKey/basePriceSnapshot/discount — before this call writes
      // anything. B556 uses this to detect (and fill) a missing planKey on activation; B557
      // uses the same snapshot to detect whether this status write crosses MrrService's
      // paying-set boundary (isPayingRow: planKey!=null && status=ACTIVE && deletedAt=null &&
      // class=PRODUCTION) so a compensating BillingEvent can be booked in either direction —
      // this plain status write used to touch neither, the documented root cause of ledgerMrr
      // drifting away from live mrr (mrr.service.ts's own doc comment, B557).
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          class: true,
          deletedAt: true,
          subscription: { select: { planKey: true, basePriceSnapshot: true, discount: true } },
        },
      });

      // The same refusal as extendTrial, on the PRIOR status read under the row lock above: the status
      // PATCH accepts any TenantStatus, so it must not be the back door for ACTIVE -> TRIAL.
      if (dto.status === "TRIAL" && before.status === "ACTIVE") throw activeTenantTrialRefusal();

      let wasRealReactivation = false;
      if (dto.status === "ACTIVE") {
        const { count } = await tx.tenant.updateMany({
          where: { id, status: { not: "ACTIVE" } },
          data: { status: dto.status },
        });
        wasRealReactivation = count === 1;
      }
      // Always followed by a plain update: `updateMany` doesn't return the row, and a lost CAS
      // (already ACTIVE) still needs the write for every other target status, so one path
      // covers both — it's an idempotent no-op re-write of the same value when the CAS already
      // won.
      const updated = await tx.tenant.update({
        where: { id },
        data: { status: dto.status },
      });

      // B556: a tenant that reaches ACTIVE with no resolved planKey is the exact "shown as
      // paying, contributes $0 forever" shape B556 reports — the historically confirmed
      // mechanism is precisely this control (create as TRIAL with no subscription row → flip
      // to ACTIVE here → nothing ever creates one). Fill ONLY planKey, resolved via the same
      // total planKeyFromEnum() mapping every other consumer already falls back to — never
      // basePriceSnapshot, which stays the deliberate job of updatePlan()/
      // activateManualSubscription() so a tenant never starts showing revenue from a bare
      // status flip alone (protects the free-pilot population — see mrr.service.ts F2/F3).
      // Never overwrites an existing planKey.
      const priorPlanKey = before.subscription?.planKey ?? null;
      let finalPlanKey = priorPlanKey;
      if (dto.status === "ACTIVE" && priorPlanKey == null) {
        finalPlanKey = planKeyFromEnum(updated.plan);
        await tx.tenantSubscription.upsert({
          where: { tenantId: id },
          create: { tenantId: id, currentPlan: updated.plan, planKey: finalPlanKey },
          update: { planKey: finalPlanKey },
        });
      }

      // FINDING-4 RULING (2026-09-14, lead): an admin reactivation does NOT clear the tenant's
      // armed downgrade. Only two paths ever arm downgradeToPlanKey — the tenant's own
      // downgrade() and updatePlan()'s scheduled branch — so the field set is always a CHOSEN
      // schedule, never a dunning threat the system armed. Reactivating is someone else acting
      // on the tenant's subscription, and clearing here revoked that choice with no event and
      // no audit line; the tenant kept paying the higher plan they had asked to leave. The
      // schedule now survives and applyScheduledDowngrades applies it when due (a schedule that
      // came due during the lapse applies on the next pass, which is the tenant's stated
      // intent). It is recorded in the admin audit meta instead, so the reactivation says what
      // it left armed. cancelAtPeriodEnd was already left untouched for the same reason.
      let armed: { planKey: string; effectiveAt: Date | null } | null = null;
      if (wasRealReactivation) {
        const sub = await tx.tenantSubscription.findUnique({
          where: { tenantId: id },
          select: { downgradeToPlanKey: true, downgradeEffectiveAt: true },
        });
        if (sub?.downgradeToPlanKey) {
          armed = { planKey: sub.downgradeToPlanKey, effectiveAt: sub.downgradeEffectiveAt };
        }
      }

      // B557: emit a compensating BillingEvent whenever this status write crosses
      // MrrService's paying-set boundary — the gap mrr.service.ts's own doc comment names
      // ("PlatformAdminService.updateStatus() ... flips tenant.status with a raw write and
      // never emits a delta, in either direction"). A tenant billed once then suspended here
      // leaves a permanent +residue in ledgerMrr while live mrr correctly drops it (or, on
      // reactivation, the mirror: live counts it again while the ledger never catches up).
      // class and deletedAt are untouched by this call, so only status (and, via the B556
      // fill-in just above, possibly planKey) can move isPayingRow between before/after.
      const wasPaying = isPayingRow(before, priorPlanKey);
      const isPaying = isPayingRow({ ...before, status: updated.status }, finalPlanKey);
      if (wasPaying !== isPaying) {
        const addons = await tx.tenantAddon.findMany({
          where: { tenantId: id, active: true },
          select: { priceSnapshot: true, quantity: true },
        });
        // basePriceSnapshot/discount are never touched by a bare status write, so the same
        // snapshot values price both the "was" and "is" side — only which side is $0 differs.
        const contribution = this.mrrService.priceSubscription(
          {
            basePriceSnapshot: before.subscription?.basePriceSnapshot ?? null,
            discount: before.subscription?.discount ?? null,
          },
          addons,
        );
        await this.billingEventService.emit(
          id,
          isPaying
            ? BILLING_EVENTS.SUBSCRIPTION_RESUMED
            : dto.status === "CANCELLED"
              ? BILLING_EVENTS.SUBSCRIPTION_CANCELED
              : BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
          { fromStatus: before.status, toStatus: updated.status, platformAdmin: true },
          {
            amountDelta: roundMoney(isPaying ? contribution : -contribution),
            actorId: adminId,
            tx,
          },
        );
      }

      return { tenant: updated, armedDowngrade: armed };
    });

    // Evict cached status so the guard picks up the change immediately
    this.tenantStatusGuard.invalidate(id);
    const action =
      dto.status === "SUSPENDED"
        ? AdminAuditAction.TENANT_SUSPENDED
        : dto.status === "ACTIVE"
          ? AdminAuditAction.TENANT_REACTIVATED
          : AdminAuditAction.TENANT_STATUS_CHANGED;
    await this.recordAdminAction(id, adminId, action, {
      status: tenant.status,
      // FINDING-4: name the schedule this reactivation deliberately left armed, so the audit
      // trail shows it rather than the tenant discovering the downgrade on the next cron pass.
      ...(armedDowngrade
        ? {
            downgradeLeftArmed: armedDowngrade.planKey,
            downgradeEffectiveAt: armedDowngrade.effectiveAt?.toISOString() ?? null,
          }
        : {}),
    });

    return { id: tenant.id, slug: tenant.slug, status: tenant.status };
  }

  /** Serialised per tenant on the `tenant-price` lock (SA-733 D8): every read and write below runs inside it. */
  updatePlan(id: string, dto: UpdateTenantPlanDto, adminId: string | null = null) {
    return underTenantPriceLock(id, () => this.updatePlanLocked(id, dto, adminId));
  }

  private async updatePlanLocked(id: string, dto: UpdateTenantPlanDto, adminId: string | null) {
    // SA-140: class/deletedAt added so wasPaying/isPaying below can use the shared isPayingRow
    // predicate — this select previously fetched only status, silently missing the two other
    // conditions payingWhere/isPayingRow require (a real, previously undetected gap: an admin
    // plan change on a non-PRODUCTION or soft-deleted-but-ACTIVE tenant could book a delta
    // `mrr` never counted).
    const before = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, plan: true, status: true, class: true, deletedAt: true },
    });
    if (!before) throw new NotFoundException(`Tenant ${id} not found`);

    // Resolve the target plan against the currently PUBLISHED PlanVersion so this write
    // stays consistent with SubscriptionMutationService.subscribe()
    // (subscription-mutation.service.ts:132-163) — planKey/planVersionId must always point
    // at a real catalog row, never just the legacy TenantPlan enum shadow.
    const targetPlanKey = planKeyFromEnum(dto.plan);
    const { version, definition } = await this.resolvePublishedPlan(targetPlanKey);

    // Prior run-rate baseline — the MRR ledger books the signed CHANGE from this state.
    // cycle/periodStart/periodEnd are read too: ADMIN-UPDATEPLAN-1 needs them to branch and
    // price like the tenant-facing path does (SubscriptionMutationService.upgrade()/downgrade()).
    const priorSub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: id },
      select: {
        planKey: true,
        basePriceSnapshot: true,
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        stripeSubId: true,
        externalPayment: true,
        discount: true,
        cycle: true,
        periodStart: true,
        periodEnd: true,
        // FINDING-1 (round 2 review, money): the admin path must be able to SEE whether a
        // cancellation is armed before it can silently interact with it (see the refusal right
        // below) — this branch was blind to the field entirely before.
        cancelAtPeriodEnd: true,
        downgradeToPlanKey: true, // R1 Option B: a pre-renewal push may have lowered Stripe's price
      },
    });

    // FINDING-1 (MUST-FIX, money): refuse ANY admin plan change — either direction — while a
    // cancellation is armed, before either branch below runs (nothing written, no event
    // emitted). SubscriptionMutationService.downgrade() is allowed to clear its OWN tenant's
    // cancelAtPeriodEnd because that is the tenant replacing their own pending cancellation
    // with their own new choice; updatePlan() is a platform admin acting on someone ELSE's
    // subscription and has no standing to make that call for them. Resuming — or letting the
    // cancellation run its course — stays the tenant's decision; it is never a side effect of
    // an admin plan edit.
    if (priorSub?.cancelAtPeriodEnd) {
      throw new BadRequestException(
        "This tenant has a cancellation pending — resolve that before changing their plan.",
      );
    }

    // ADMIN-UPDATEPLAN-1 (lead ruling 2026-09-13): branch exactly like the tenant path
    // (subscribe()/upgrade()/downgrade()) instead of always applying instantly with no
    // proration. An UPGRADE stays instant but now surfaces a prorated "due today" figure; a
    // DOWNGRADE for an ACTIVE tenant now SCHEDULES at period end with no proration/credit — a
    // deliberate behaviour change for admins (today's instant, uncredited downgrade was
    // strictly worse than the tenant path). A same-rank, custom (Enterprise), or off-catalog
    // plan is none of those — B58 never built a "change" for them either — so that bucket keeps
    // today's instant-apply, no-proration behaviour untouched. FINDING-2: neither does a
    // non-ACTIVE tenant (READ_ONLY, TRIAL, SUSPENDED, …) — billing-cron.service.ts's
    // applyScheduledDowngrades() filters on `tenant.status === "ACTIVE"`, so scheduling one for
    // any other status is a schedule the cron can never fire; those tenants keep the pre-wave
    // instant-apply behaviour by falling through to the shared path below. `rankFrom`/`rankTo`
    // are guarded defensively (mirroring SubscriptionMutationService's own style): a loaded
    // tenant's `Tenant.plan` always resolves to a real rank via planKeyFromEnum, so neither is
    // actually expected to be -1 here.
    const fromKey = normalizePlanKey(priorSub?.planKey) ?? planKeyFromEnum(before.plan);
    const fromDefinition = findPlanDefinition(version.definitions, fromKey);
    const rankFrom = planRank(fromKey);
    const rankTo = planRank(targetPlanKey);
    const isRankedPlanChange =
      rankFrom >= 0 &&
      rankTo >= 0 &&
      rankFrom !== rankTo &&
      !definition.isCustom &&
      !fromDefinition?.isCustom;

    // `before.status` was read once, at the very top of this method, before this call wrote
    // anything — the tenant's status immediately prior to this mutation, exactly what
    // applyScheduledDowngrades() will see if a schedule is armed here.
    if (isRankedPlanChange && rankTo < rankFrom && before.status === "ACTIVE") {
      // DOWNGRADE (ACTIVE tenant only) — schedule at period end, no proration/credit: the same
      // fields SubscriptionMutationService.downgrade() writes, never applied instantly. R4 (the
      // ledger trap): the MRR delta is booked ONLY when billing-cron.service.ts
      // applyScheduledDowngrades() actually fires the change later — booking it now (or a
      // second time when the cron fires) would silently corrupt the run-rate.
      if (!priorSub?.periodEnd) {
        throw new BadRequestException(
          "This tenant has no active billing period — activate a subscription before scheduling a downgrade.",
        );
      }
      await this.prisma.$transaction(async (tx) => {
        await lockTenantForLedger(tx, id); // #2551 / SA-503a: Tenant before the subscription
        await tx.tenantSubscription.update({
          where: { tenantId: id },
          data: {
            downgradeToPlanKey: definition.planKey,
            downgradeEffectiveAt: priorSub.periodEnd,
            retainedUserIds: [],
            // FINDING-1: cancelAtPeriodEnd is never written here. The refusal above already
            // guarantees no cancellation is armed by the time this write runs, and even so this
            // path has no standing to touch a tenant's own cancellation choice — see the
            // refusal for the full reasoning.
          },
        });
        // Mirrors downgrade()'s own ledger shape: PLAN_DOWNGRADE_SCHEDULED at amountDelta 0,
        // never PLAN_CHANGED — the run-rate has not moved yet.
        await this.billingEventService.emit(
          id,
          BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED,
          {
            fromPlan: fromKey,
            toPlan: definition.planKey,
            effectiveAt: priorSub.periodEnd,
            platformAdmin: true,
          },
          { amountDelta: 0, actorId: adminId, tx },
        );
      });

      await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_PLAN_CHANGED, {
        from: before.plan,
        to: dto.plan,
        scheduled: true,
        effectiveAt: priorSub.periodEnd,
      });

      // Nothing about current entitlements changed (only the schedule was armed) — no
      // invalidate, mirroring downgrade()'s own behaviour.
      return {
        id: before.id,
        slug: before.slug,
        plan: before.plan,
        downgradeToPlanKey: definition.planKey,
        downgradeEffectiveAt: priorSub.periodEnd,
      };
    }

    // UPGRADE — instant, with the prorated price difference surfaced (never charged via
    // Stripe here; both admin and tenant plan-change paths are Stripe-silent). Computed from
    // the SAME shared helper and the SAME inputs (sub window + monthly-price delta) the
    // tenant-facing upgrade() uses, so the two paths never drift apart on the money math.
    // #2223 / SA-444a: an override row keeps paying its negotiated fee — the upgrade quotes 0.
    const override = priceOverrideOf(priorSub);
    const proratedNow =
      isRankedPlanChange && rankTo > rankFrom
        ? override != null
          ? 0
          : this.proration.proratedDiff(
              {
                cycle: priorSub?.cycle ?? "MONTHLY",
                periodStart: priorSub?.periodStart ?? null,
                periodEnd: priorSub?.periodEnd ?? null,
              },
              Number(definition.monthlyPrice ?? 0) - Number(fromDefinition?.monthlyPrice ?? 0),
            )
        : null;

    // A custom (Enterprise) definition has no catalog price — the tenant's negotiated fee
    // lives in `priceOverrideMonthly` instead. Writing `planKey` with a null snapshot would
    // enter the tenant in the rollup at $0 base while its active add-ons start counting
    // (mrr.service.ts:63-66), the "add-on MRR with no base behind it" that guard warns about.
    // SA-444a: the snapshot is what the tenant PAYS, so the negotiated fee comes first — a
    // catalog-target change on an override row keeps it (delta 0, MRR and ledger unmoved).
    const baseSnapshot = priorSub?.priceOverrideMonthly ?? definition.monthlyPrice ?? null;

    // SA-140: uses the shared isPayingRow predicate — this previously checked only
    // status+planKey, missing class/deletedAt (a real gap: a plan change on an ACTIVE but
    // non-PRODUCTION or soft-deleted tenant could book a delta `mrr` never counts). This write
    // always sets planKey, so an ACTIVE (and PRODUCTION, non-deleted) tenant is paying
    // afterwards — a manual/external activation (which deliberately leaves planKey null)
    // CROSSES in here. class/deletedAt are untouched by this write, so `before` covers both
    // sides — only which planKey is evaluated differs.
    const wasPaying = isPayingRow(before, priorSub?.planKey ?? null);
    const isPaying = isPayingRow(before, definition.planKey);

    const transition = {
      tenantId: id,
      fromPlanKey: fromKey,
      toPlanKey: definition.planKey,
      toPlanVersionId: version.id,
      actor: { id: adminId },
    };
    const preparedTransition = await this.planTransition.prepare(transition);

    // SA-733r M7: Stripe FIRST (price + retired add-on items in one update); `flow.settle` puts it back if the
    // write below throws. A re-save of the tenant's own plan pushes nothing.
    const isUpgrade = isRankedPlanChange && rankTo > rankFrom;
    // A move to a HIGHER plan retires the add-ons the target includes even when the target is a custom plan
    // (GROWTH -> ENTERPRISE); only the proration rule keeps the ranked-and-priced test.
    const retiresAddons = rankFrom >= 0 && rankTo > rankFrom;
    // R1 Option B: undo an early pre-renewal downgrade push BEFORE this change prorates from Stripe's price.
    if (priorSub?.stripeSubId && priorSub.downgradeToPlanKey && fromKey !== targetPlanKey) {
      await this.scheduledPrice?.restoreIfPushedLocked(id, priorSub.downgradeToPlanKey, {
        mustBeCleared: false,
        audience: "admin",
      });
    }
    const flowArgs = planChangeArgs({
      tenantId: id,
      sub: priorSub,
      version,
      def: definition,
      proration: isUpgrade ? "create_prorations" : "none",
      retireAddons: retiresAddons,
      actorId: adminId,
      audience: "admin",
    });
    const manual = await manualPayContext(this.prisma, id, this.stripe.isConfigured, priorSub);
    const flow = await beginStripeFirstPlanChange(
      { prisma: this.prisma, stripe: this.stripe, logger: this.logger },
      fromKey === targetPlanKey ? { ...flowArgs, stripeSubId: null } : flowArgs,
    );
    const written = this.prisma.$transaction(async (tx) => {
      await this.planTransition.onPlanChange(tx, transition, preparedTransition);
      // Hook FIRST (house lock order: snapshot/config rows before tenant rows, as upgrade() does).
      // #2470 / SA-485b (i): priorSub, `before` and everything derived from them were read BEFORE this
      // tx. Take the Tenant row lock updateTenantPriceOverride and reconcilePriceLedger take, then write
      // by compare-and-set on what was read — the tenant's status, the subscription's planKey + fee +
      // snapshot. Anything that moved since (a Pricing change, its reconcile, a status change) is a 409,
      // never a stale fee/snapshot written back or a double-booked delta.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
      const conflict = () =>
        new ConflictException("The subscription changed concurrently — please retry.");
      const updated = await tx.tenant
        .update({
          where: { id, status: before.status },
          data: { plan: dto.plan, planVersionId: version.id },
        })
        .catch((e: unknown) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025")
            throw conflict();
          throw e;
        });
      // The subscription moves to the target plan — the same catalog-derived fields subscribe()
      // writes. `basePriceSnapshot` must move WITH `planKey`: MrrService prices a tenant from the
      // snapshot alone (mrr.service.ts:82), so a stale/null one would book the old plan's price.
      const subWrite = {
        currentPlan: dto.plan,
        planKey: definition.planKey,
        planVersionId: version.id,
        basePriceSnapshot: baseSnapshot,
      };
      if (priorSub) {
        const { count } = await tx.tenantSubscription.updateMany({
          where: {
            tenantId: id,
            planKey: priorSub.planKey ?? null,
            priceOverrideMonthly: priorSub.priceOverrideMonthly ?? null,
            basePriceSnapshot: priorSub.basePriceSnapshot ?? null,
          },
          data: {
            ...subWrite,
            // A committing plan write disarms any scheduled downgrade — the same invariant every
            // self-service writer holds (subscription-mutation.service.ts). Left armed, the 02:00
            // sweep (which filters on downgradeEffectiveAt alone) would silently undo this change
            // and deactivate the tenant's staff. `cancelAtPeriodEnd` is deliberately NOT touched: an
            // admin plan edit must not revoke a cancellation the tenant asked for (resume()'s job).
            downgradeToPlanKey: null,
            downgradeEffectiveAt: null,
            retainedUserIds: [],
          },
        });
        if (count === 0) throw conflict();
      } else {
        // #2549: two concurrent first-plan writes both read "no row"; the loser's create hits the
        // tenantId unique key (P2002) — the same lost race as a guarded-update miss, so the same 409
        // (the tx rolls back: nothing written, nothing booked).
        await tx.tenantSubscription
          .create({ data: { tenantId: id, ...subWrite } })
          .catch((e: unknown) => {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
              throw conflict();
            throw e;
          });
      }

      // Moving the snapshot run-rate without a matching ledger delta makes `mrr` and
      // `ledgerMrr`/`momDelta` diverge permanently (mrr.service.ts:21-27), so this path
      // emits PLAN_CHANGED in the same transaction like every other run-rate mover
      // (subscribe() :212-217, upgrade() :298-303, the downgrade cron). Contribution
      // mirrors BillingService.emitPayingDelta: base + Σ active add-ons − discount.
      // Add-ons and the discount are untouched here, so they cancel out unless the tenant
      // crosses in/out of the paying set — only then is the extra query worth making.
      let extras = 0;
      if (wasPaying !== isPaying) {
        const addons = await tx.tenantAddon.findMany({
          where: { tenantId: id, active: true },
          select: { priceSnapshot: true, quantity: true },
        });
        extras =
          addons.reduce(
            (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
            0,
          ) - Number(priorSub?.discount ?? 0);
      }
      const priorContribution = wasPaying
        ? roundMoney(Number(priorSub?.basePriceSnapshot ?? 0) + extras)
        : 0;
      const nextContribution = isPaying ? roundMoney(Number(baseSnapshot ?? 0) + extras) : 0;
      await this.billingEventService.emit(
        id,
        BILLING_EVENTS.PLAN_CHANGED,
        {
          fromPlan: priorSub?.planKey ?? null,
          toPlan: definition.planKey,
          platformAdmin: true,
          ...(flow.ctx.idempotencyKey ? { stripeIdempotencyKey: flow.ctx.idempotencyKey } : {}),
        },
        { amountDelta: roundMoney(nextContribution - priorContribution), actorId: adminId, tx },
      );
      await flow.retireAddons(tx, this.billingEventService, { ...manual, actorId: adminId });
      return updated;
    }, this.planTransition.transactionOptions(preparedTransition));
    const settled = await flow.settle(written);
    // A lost commit acknowledgement: the write LANDED, so carry on exactly as a success (audit row, caches) and
    // re-read the row the transaction would have returned.
    const tenant =
      settled === PLAN_CHANGE_LANDED
        ? await this.prisma.tenant.findUniqueOrThrow({ where: { id } })
        : settled;

    this.planTransition.invalidateCaches(id, preparedTransition);
    this.entitlementsService.invalidate(id);

    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_PLAN_CHANGED, {
      from: before.plan,
      to: tenant.plan,
    });
    return {
      id: tenant.id,
      slug: tenant.slug,
      plan: tenant.plan,
      // Stripe sends proration none on a trialing / past_due / unpaid subscription: no charge to claim.
      ...(proratedNow != null
        ? { proratedNow: flow.ctx.proration === "none" ? 0 : proratedNow }
        : {}),
      ...(proratedNow != null && override != null ? { note: CUSTOM_FEE_UNCHANGED } : {}),
    };
  }

  // ─── Manual subscription activation (non-Stripe payment) ─────────────────────

  async activateManualSubscription(
    id: string,
    dto: ActivateSubscriptionDto,
    adminId: string | null = null,
  ) {
    await this._findOrThrow(id);

    // FINDING-2 (Lite-L2 review): resolve + validate against the published catalog, and persist
    // both planKey and planVersionId — this write previously set tenant.plan/currentPlan with no
    // catalog check at all, and never re-pinned the subscription's planKey/planVersionId, so a
    // later compute() couldn't find the tenant's plan either.
    const planKey = planKeyFromEnum(dto.plan);
    const { version, definition } = await this.resolvePublishedPlan(planKey);

    const now = new Date();
    const periodEnd = new Date(now.getTime() + dto.billingPeriodDays * 24 * 60 * 60 * 1000);
    // B863 / SA-277: 365-day prepaid = ANNUAL, shorter = MONTHLY; external rows roll length-preserving (rollCycles).
    const cycle: "MONTHLY" | "ANNUAL" = dto.billingPeriodDays >= 365 ? "ANNUAL" : "MONTHLY";

    // Lane B A2b: the plan being LEFT, read before the transaction so the catalog read in
    // `prepare()` also happens outside it. A tenant with no subscription row falls back to
    // `Tenant.plan`, exactly like updatePlan().
    // Read ONLY while the snapshot flag is on: flag off, this method issues exactly the queries it
    // did before the hook existed.
    const snapshotOn = await this.planTransition.isEnabled();
    const prior = snapshotOn
      ? await this.prisma.tenant.findUniqueOrThrow({
          where: { id },
          select: { plan: true, subscription: { select: { planKey: true } } },
        })
      : null;
    const transition = prior
      ? {
          tenantId: id,
          fromPlanKey: normalizePlanKey(prior.subscription?.planKey) ?? planKeyFromEnum(prior.plan),
          toPlanKey: definition.planKey,
          toPlanVersionId: version.id,
          actor: { id: adminId },
        }
      : null;
    const preparedTransition = transition ? await this.planTransition.prepare(transition) : null;

    // SA-668c residual: the trial's unbilled self-serve add-ons are priced by this activation (see
    // `priceUnbilledAddonsOnActivation`). Their billing add-on locks are taken BEFORE the transaction
    // (house order: add-on lock, then the tenant row lock inside it); none to price, none taken.
    const addonSkusToPrice = await unbilledSelfServeSkus(this.prisma, id);

    const tenant = await withAddonLocks(id, addonSkusToPrice, () =>
      this.prisma.$transaction(async (tx) => {
        // B864 / SA-277 (D2): same tenant row lock as updateStatus/updateTenantClass/
        // updateTenantPriceOverride.
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
        if (transition && preparedTransition) {
          await this.planTransition.onPlanChange(tx, transition, preparedTransition);
        }
        // B557 (B551's mirror-image gap): capture the tenant's paying-set inputs BEFORE this
        // call writes anything. This activation can move a tenant into MrrService's paying set
        // (status→ACTIVE + a resolved planKey) with no compensating BillingEvent today — the
        // write and the event must land or roll back together, exactly like updatePlan()'s own
        // upsert+emit elsewhere in this file.
        const before = await tx.tenant.findUniqueOrThrow({
          where: { id },
          select: {
            name: true,
            slug: true,
            status: true,
            readOnlyReason: true,
            class: true,
            deletedAt: true,
            subscription: {
              select: {
                planKey: true,
                basePriceSnapshot: true,
                discount: true,
                priceOverrideMonthly: true,
              },
            },
          },
        });

        // B557 / SA-140: status is unconditionally ACTIVE and planKey unconditionally resolved by
        // the write below, so only class/deletedAt (untouched here) gate whether this activation
        // actually crosses into MrrService's paying set — via the shared isPayingRow predicate.
        const wasPaying = isPayingRow(before, before.subscription?.planKey ?? null);
        const isPaying = isPayingRow({ ...before, status: "ACTIVE" }, definition.planKey);
        // #2460 / SA-464 (1): manual activation is a PAID path (owner 09-24), so a crossing INTO the
        // paying set snapshots what the tenant pays — a negotiated override (0 = free, explicitly),
        // else the catalog price — in this same tx, and books it below. A renewal of a row already in
        // the set writes no snapshot and books nothing (a legacy NULL stays NULL, reported as unpriced).
        const crossingIn = !wasPaying && isPaying;
        // #2522 / SA-464f: a renewal of an already-paying row that also changes planKey is a ranked
        // plan change — rebase the snapshot onto the NEW plan and book the difference below.
        const planSwitch =
          wasPaying &&
          isPaying &&
          normalizePlanKey(before.subscription?.planKey) !== definition.planKey;
        const override = before.subscription?.priceOverrideMonthly;
        // #2570: round every monetary write — the snapshot (and so the delta booked from it) at cents.
        const newBase =
          override != null
            ? roundMoney(Number(override))
            : definition.monthlyPrice != null
              ? roundMoney(Number(definition.monthlyPrice))
              : null;
        const snapshotWrite = crossingIn || planSwitch ? { basePriceSnapshot: newBase } : {};

        const [updated] = await Promise.all([
          tx.tenant.update({
            where: { id },
            // readOnlyReason is cleared with the status (as every other ACTIVE write does): RO-1 ships it to
            // the client, and a lapsed trial's "trial_expired" must not outlive the READ_ONLY it explained.
            data: { status: "ACTIVE", plan: dto.plan, readOnlyReason: null },
            select: { id: true, slug: true, status: true, plan: true },
          }),
          tx.tenantSubscription.upsert({
            where: { tenantId: id },
            create: {
              tenantId: id,
              currentPlan: dto.plan,
              planKey: definition.planKey,
              planVersionId: version.id,
              periodStart: now,
              periodEnd,
              cycle,
              externalPayment: true,
              externalPaymentMethod: dto.paymentMethod,
              externalPaymentRef: dto.paymentRef ?? null,
              externalPaymentNotes: dto.notes ?? null,
              ...snapshotWrite,
            },
            update: {
              currentPlan: dto.plan,
              planKey: definition.planKey,
              planVersionId: version.id,
              periodStart: now,
              periodEnd,
              cycle,
              // Rolling the period forward disarms every pending transition. A downgrade left
              // armed now points at the OLD (already past) period end, so the very next 02:00
              // sweep would fire it against the subscription this admin just activated.
              cancelAtPeriodEnd: false,
              downgradeToPlanKey: null,
              downgradeEffectiveAt: null,
              retainedUserIds: [],
              externalPayment: true,
              externalPaymentMethod: dto.paymentMethod,
              externalPaymentRef: dto.paymentRef ?? null,
              externalPaymentNotes: dto.notes ?? null,
              ...snapshotWrite,
            },
          }),
        ]);

        if (wasPaying !== isPaying) {
          // SA-693 / S4: only BILLABLE add-ons cross into the ledger — a comp is a platform grant (never
          // revenue), and one billed before it became a comp can still carry its stored snapshot.
          const addons = await tx.tenantAddon.findMany({
            where: billableAddonWhere({ tenantId: id, active: true }),
            select: { priceSnapshot: true, quantity: true, sku: true, addonKey: true },
          });
          // #2460 / SA-464: entering, the contribution is priced off the snapshot this call just
          // wrote (after − before, where before contributed 0 outside the set); leaving (latent,
          // see below), off the stored snapshot the tenant was counted at (−before).
          // SA-277b: the PLAN_CHANGED amount here is the BASE (plan) share only — the add-on
          // share of this same crossing is booked separately, through `bookAddonsOnCrossing`
          // below (the SAME helper `subscribe()` uses for its own kept/prior add-ons), so nothing
          // is double-counted between a plan.changed row and the addon.enabled rows it books.
          const baseContribution = this.mrrService.priceSubscription(
            {
              basePriceSnapshot: crossingIn
                ? newBase
                : (before.subscription?.basePriceSnapshot ?? null),
              discount: before.subscription?.discount ?? null,
            },
            [],
          );
          await this.billingEventService.emit(
            id,
            BILLING_EVENTS.PLAN_CHANGED,
            {
              fromPlan: before.subscription?.planKey ?? null,
              toPlan: definition.planKey,
              platformAdmin: true,
              externalActivation: true,
            },
            {
              amountDelta: roundMoney(isPaying ? baseContribution : -baseContribution),
              actorId: adminId,
              tx,
            },
          );
          // Latent-case guard (pre-merge review): `bookAddonsOnCrossing`'s `wasPaying` flag only
          // knows how to book a tenant CROSSING INTO the paying set (booking each add-on's full
          // contribution) — it has no "debit" branch for a tenant that left it. Unreachable
          // today: this method forces `status: "ACTIVE"` unconditionally above and never touches
          // `class`/`deletedAt`, so `isPaying` can only be `false` here if `wasPaying` already
          // was (isPayingRow needs status=ACTIVE too) — i.e. wasPaying implies isPaying. Kept as
          // a fail-loud guard in case that invariant ever changes, rather than silently booking
          // the wrong direction.
          if (wasPaying && !isPaying) {
            throw new InternalServerErrorException(
              "activation left the paying set — add-on debit not implemented",
            );
          }
          // SA-277b: add-ons book through the SAME crossing helper `subscribe()` uses —
          // `wasPaying` gates whether each add-on's contribution was already on the ledger.
          await bookAddonsOnCrossing(
            tx,
            this.billingEventService,
            id,
            addons.map((a) => ({
              sku: addonSkuCode(a) ?? a.addonKey,
              priceSnapshot: a.priceSnapshot,
              quantity: a.quantity,
            })),
            wasPaying,
            adminId,
          );
        }

        // #2522 / SA-464f: already paying on both sides, so add-ons and the discount cancel — the
        // base alone moves: Δ = newBase − (stored snapshot ?? 0). An override row books Δ0; a legacy
        // NULL self-heals (books the full new base, as upgrade()/updatePlan do).
        if (planSwitch) {
          await this.billingEventService.emit(
            id,
            BILLING_EVENTS.PLAN_CHANGED,
            {
              fromPlan: before.subscription?.planKey ?? null,
              toPlan: definition.planKey,
              platformAdmin: true,
              externalActivation: true,
            },
            {
              amountDelta: roundMoney(
                Number(newBase ?? 0) - Number(before.subscription?.basePriceSnapshot ?? 0),
              ),
              actorId: adminId,
              tx,
            },
          );
        }

        // SA-668c residual ("price them + notify"): after the crossing above (which saw the trial's
        // add-ons at their stored 0 and booked nothing for them), each unbilled self-serve add-on is
        // priced at today's catalog price, its delta booked once, and the platform told to invoice it.
        // ONLY on the TRIAL → ACTIVE crossing (M-A): the status read above, under the tenant row lock,
        // (with `readOnlyReason`, so a LAPSED trial counts too) is what the helper gates on — a renewal of an
        // already-ACTIVE manual tenant prices nothing.
        if (addonSkusToPrice.length > 0) {
          await priceUnbilledAddonsOnActivation(tx, this.billingEventService, {
            tenantId: id,
            tenantLabel: before.name ?? before.slug ?? id,
            fromStatus: before.status,
            readOnlyReason: before.readOnlyReason,
            tenantClass: before.class,
            cycle,
            planKey: definition.planKey,
            catalogAddons: version.addonSkus,
            actorId: adminId,
          });
        }

        // The billing MARKER of this activation, in the SAME transaction (and under the same tenant row lock) as
        // the externalPayment write: a card checkout completing later re-reads the latest marker under that lock
        // to tell "moved to manual invoicing AFTER the session was created" from a cron cycle roll (which also
        // moves periodStart, and writes no marker). Never the best-effort post-commit trail row below.
        await tx.auditLog.create({
          data: {
            tenantId: id,
            userId: adminId,
            action: AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER,
            entityType: ADMIN_AUDIT_ENTITY,
            entityId: id,
            meta: {
              platformAdmin: true,
              plan: dto.plan,
              paymentMethod: dto.paymentMethod,
              cycle,
              periodEnd: periodEnd.toISOString(),
            },
          },
        });

        return updated;
      }, this.planTransition.transactionOptions(preparedTransition)),
    );

    this.planTransition.invalidateCaches(id, preparedTransition);
    // Invalidate cached tenant status so the guard picks up ACTIVE immediately
    this.tenantStatusGuard.invalidate(id);

    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_SUBSCRIPTION_ACTIVATED, {
      plan: tenant.plan,
      paymentMethod: dto.paymentMethod,
      paymentRef: dto.paymentRef ?? null,
      periodEnd,
    });

    return {
      id: tenant.id,
      slug: tenant.slug,
      status: tenant.status,
      plan: tenant.plan,
      periodStart: now,
      periodEnd,
      paymentMethod: dto.paymentMethod,
      paymentRef: dto.paymentRef ?? null,
    };
  }

  // ─── Impersonation ────────────────────────────────────────────────────────────

  /**
   * Issues a short-lived (15-min) access token with the target tenant-admin
   * user's claims plus `impersonatedBy: superAdminId`.
   * The ImpersonationGuard logs write operations for audit trail purposes;
   * impersonation sessions have full write access (same as the impersonated user).
   */
  async impersonate(tenantId: string, superAdminId: string) {
    const tenant = await this._findOrThrow(tenantId);

    // Find the TENANT_ADMIN user for this tenant
    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
    });
    if (!adminUser) throw new NotFoundException("No active TENANT_ADMIN found for this tenant");

    const jwtConfig = this.config.get<AppConfig["jwt"]>("jwt")!;

    const payload: JwtPayload & { impersonatedBy: string } = {
      sub: adminUser.id,
      username: adminUser.username,
      role: adminUser.role,
      status: adminUser.status,
      forcePasswordChange: false,
      tenantId,
      tenantSlug: tenant.slug,
      isAdmin: adminUser.isAdmin || adminUser.role === "TENANT_ADMIN",
      canActAsDriver: adminUser.canActAsDriver,
      impersonatedBy: superAdminId,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      audience: STAFF_ACCESS_AUDIENCE,
      expiresIn: "15m",
    });

    // Record the start of the impersonation session against the target tenant.
    // Per-write provenance during the session is a separate (audit-module) concern;
    // this row is what makes "Impersonation session" visible in the tenant's trail.
    await this.recordAdminAction(tenantId, superAdminId, AdminAuditAction.IMPERSONATION_STARTED, {
      impersonatedUserId: adminUser.id,
      impersonatedUsername: adminUser.username,
      expiresInSeconds: 900,
    });

    return {
      accessToken,
      expiresIn: 900,
      impersonatedTenant: { id: tenantId, slug: tenant.slug },
      impersonatedUser: { id: adminUser.id, username: adminUser.username },
    };
  }

  // ─── Platform stats ───────────────────────────────────────────────────────────

  async getStats() {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Phase 0 T9: every tenant-scoped query below adds class: "PRODUCTION" — the first
    // five customers are FREE PILOTS/TRIALS, and every TEST/DEMO/INTERNAL tenant
    // (routeflow-demo, qa-*/e2e-*/ux-audit-* slugs, routeflow-hq) must be invisible to the
    // dashboard's counts, not only to MRR. superAdminCount is deliberately NOT tenant-scoped
    // (it counts platform staff, who have no tenantId).
    //
    // B543: the five tenant-count queries below also need
    // `deletedAt: null` — every sibling tenant query in this same file/Promise.all
    // (planScanRows just below, getBillingOverview(), listTenants()) already excludes
    // soft-deleted rows; these five were the only ones that didn't, so a soft-deleted
    // PRODUCTION tenant was still counted into TOTAL TENANTS / ACTIVE / TRIAL / SUSPENDED
    // and into "+N this month". Fixing this DROPS the visible numbers — that is correct,
    // not a regression.
    const [
      totalTenants,
      activeTenants,
      trialTenants,
      suspendedTenants,
      totalUsers,
      superAdminCount,
      newTenantsThisMonth,
      planScanRows,
      recentTenants,
      trialsExpiringSoon,
      atRiskTenants,
      mrrOverview,
    ] = await Promise.all([
      this.prisma.tenant.count({ where: { deletedAt: null, class: "PRODUCTION" } }),
      this.prisma.tenant.count({
        where: { deletedAt: null, status: TenantStatus.ACTIVE, class: "PRODUCTION" },
      }),
      this.prisma.tenant.count({
        where: { deletedAt: null, status: TenantStatus.TRIAL, class: "PRODUCTION" },
      }),
      this.prisma.tenant.count({
        where: { deletedAt: null, status: TenantStatus.SUSPENDED, class: "PRODUCTION" },
      }),
      // B536: "Total Users" is a staff-only KPI — it must mirror users.service.ts
      // findAll()'s `role: { not: UserRole.CUSTOMER }` predicate (the per-tenant Users
      // list already excludes buyer-portal customer logins), plus `deletedAt: null`.
      // Before this it counted every User row — staff AND every CUSTOMER login,
      // including soft-deleted ones — producing an implausible total (2138 across 26
      // tenants) with no stated definition. Fixing this DROPS the visible number
      // sharply — that is correct, not a regression.
      this.prisma.user.count({
        where: {
          tenantId: { not: null },
          tenant: { class: "PRODUCTION" },
          role: { not: UserRole.CUSTOMER },
          deletedAt: null,
        },
      }),
      this.prisma.user.count({ where: { role: "SUPER_ADMIN" } }),
      this.prisma.tenant.count({
        where: { deletedAt: null, createdAt: { gte: startOfMonth }, class: "PRODUCTION" },
      }),
      // Plan distribution (counts only, no longer prices — MrrService is the one MRR
      // engine below). Excludes cancelled/soft-deleted tenants (hidden everywhere else).
      // Keyed on the tenant's normalized planKey (subscription.planKey, else the legacy
      // `plan` enum mapped forward).
      this.prisma.tenant.findMany({
        where: {
          deletedAt: null,
          status: { not: TenantStatus.CANCELLED },
          class: "PRODUCTION",
        },
        select: { status: true, plan: true, subscription: { select: { planKey: true } } },
      }),
      this.prisma.tenant.findMany({
        where: { class: "PRODUCTION" },
        take: 5,
        orderBy: { createdAt: "desc" },
        select: { id: true, slug: true, name: true, status: true, plan: true, createdAt: true },
      }),
      // Trials expiring within 7 days
      this.prisma.tenant.findMany({
        where: {
          status: TenantStatus.TRIAL,
          trialEndsAt: { lte: sevenDaysFromNow, gte: now },
          class: "PRODUCTION",
        },
        orderBy: { trialEndsAt: "asc" },
        select: {
          id: true,
          slug: true,
          name: true,
          plan: true,
          trialEndsAt: true,
          createdAt: true,
          _count: { select: { users: true } },
        },
      }),
      // At-risk: suspended or expired trials
      this.prisma.tenant.findMany({
        where: {
          class: "PRODUCTION",
          OR: [
            { status: TenantStatus.SUSPENDED },
            { status: TenantStatus.TRIAL, trialEndsAt: { lt: now } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, slug: true, name: true, status: true, plan: true, trialEndsAt: true },
      }),
      this.mrrService.computeOverview(),
    ]);

    // Plan distribution keyed on the current catalog's planKey (STARTER/GROWTH/
    // SCALE/ENTERPRISE), not the legacy `plan` enum shadow.
    const planCounts: Record<string, number> = {};
    for (const t of planScanRows) {
      const planKey = this._resolveDisplayPlanKey(t);
      planCounts[planKey] = (planCounts[planKey] ?? 0) + 1;
    }

    return {
      tenants: {
        total: totalTenants,
        active: activeTenants,
        trial: trialTenants,
        suspended: suspendedTenants,
      },
      totalUsers,
      superAdminCount,
      newTenantsThisMonth,
      // One MRR engine: MrrService.computeOverview() prices from the per-tenant snapshot,
      // already scoped to class: "PRODUCTION" (see mrr.service.ts). `mrr` is the live
      // run-rate; `ledgerMrr` reconciles it against the append-only BillingEvent ledger.
      mrr: mrrOverview.mrr,
      ledgerMrr: mrrOverview.ledgerMrr,
      planBreakdown: planCounts,
      recentTenants,
      trialsExpiringSoon: trialsExpiringSoon.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        plan: t.plan,
        trialEndsAt: t.trialEndsAt,
        createdAt: t.createdAt,
        userCount: t._count.users,
      })),
      atRiskTenants: atRiskTenants.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        plan: t.plan,
        trialEndsAt: t.trialEndsAt,
        riskReason: this._riskReason(t.status, t.trialEndsAt, now),
      })),
    };
  }

  /** Human-readable "why at risk" for the dashboard At-Risk table. */
  private _riskReason(status: string, trialEndsAt: Date | null, now: Date): string {
    if (status === "SUSPENDED") return "Suspended";
    if (status === "TRIAL" && trialEndsAt && trialEndsAt < now) {
      const days = Math.floor((now.getTime() - trialEndsAt.getTime()) / (1000 * 60 * 60 * 24));
      return days <= 0 ? "Trial expired today" : `Trial expired ${days}d ago`;
    }
    return "At risk";
  }

  // ─── Growth stats ─────────────────────────────────────────────────────────────

  async getGrowthStats(months = 12) {
    const results: { month: string; count: number }[] = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      // REG-743-N4: PRODUCTION-only, matching every other admin count (Phase 0 T9) — a
      // qa-*/e2e-*/ux-audit-* or routeflow-demo tenant created during this window must not
      // move the growth chart shown next to newTenantsThisMonth (getStats()), which T9
      // already scoped.
      const count = await this.prisma.tenant.count({
        where: { createdAt: { gte: start, lt: end }, class: "PRODUCTION" },
      });
      results.push({
        month: start.toISOString().slice(0, 7), // "2026-01"
        count,
      });
    }
    return results;
  }

  // ─── Billing overview ─────────────────────────────────────────────────────────

  async getBillingOverview() {
    // REG-743-N4: every count here is PRODUCTION-only, matching MrrService/getStats() —
    // a qa-*/e2e-*/ux-audit-* or routeflow-demo tenant's subscription/trial status must
    // never move the conversion-rate figures this admin page computes from these counts.
    const [subscriptions, totalTenants, trialTenants] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: { tenant: { class: "PRODUCTION", deletedAt: null } },
        include: {
          tenant: {
            select: { id: true, slug: true, name: true, status: true, plan: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.tenant.count({ where: { class: "PRODUCTION", deletedAt: null } }),
      this.prisma.tenant.count({
        where: { status: TenantStatus.TRIAL, class: "PRODUCTION", deletedAt: null },
      }),
    ]);

    const activeSubscriptions = subscriptions.filter(
      (s) => s.tenant.status === "ACTIVE" && !s.cancelAtPeriodEnd,
    );
    const cancelPending = subscriptions.filter((s) => s.cancelAtPeriodEnd);

    return {
      activeSubscriptions: activeSubscriptions.length,
      cancelPending: cancelPending.length,
      totalTenants,
      trialTenants,
      subscriptions: subscriptions.map((s) => ({
        tenantId: s.tenantId,
        tenantSlug: s.tenant.slug,
        tenantName: s.tenant.name,
        tenantStatus: s.tenant.status,
        currentPlan: s.currentPlan,
        periodEnd: s.periodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        stripeCustomerId: s.stripeCustomerId,
      })),
    };
  }

  // ─── Platform pricing (catalog-driven Stripe prices + tenant overrides) ───────

  /**
   * Resolved pricing for a tenant (catalog or custom override) plus whether it has
   * a live Stripe subscription, so the admin UI can explain what "apply" will do.
   *
   * An UNRESOLVABLE price (ENTERPRISE / `isCustom` with no custom fee yet) is reported
   * as `resolvable: false` + a reason, NOT a 400 — those are exactly the tenants that
   * need the admin UI's custom-fee form, so the read must never fail them out of it.
   */
  async getTenantPricing(id: string) {
    const [pricing, sub] = await Promise.all([
      this.platformPricingService.resolveTenantPricing(id).catch((e) => {
        if (e instanceof BadRequestException) return null;
        throw e;
      }),
      this.prisma.tenantSubscription.findUnique({
        where: { tenantId: id },
        select: {
          stripeSubId: true,
          cancelAtPeriodEnd: true,
          periodEnd: true,
          billingInterval: true,
          priceOverrideMonthly: true,
          priceOverrideAnnual: true,
        },
      }),
    ]);

    const hasLiveSubscription = !!sub?.stripeSubId;
    return {
      resolvable: pricing !== null,
      planKey: pricing?.planKey ?? null,
      planName: pricing?.planName ?? null,
      monthly: pricing?.monthly ?? null,
      annual: pricing?.annual ?? null,
      source: pricing?.source ?? null,
      currency: "usd" as const,
      // The RAW override columns, not just the resolved figures: the admin UI prefills
      // its inputs from these, so re-saving a custom fee can't silently wipe a
      // negotiated annual price the resolver had already folded away.
      override: {
        monthly: sub?.priceOverrideMonthly == null ? null : Number(sub.priceOverrideMonthly),
        annual: sub?.priceOverrideAnnual == null ? null : Number(sub.priceOverrideAnnual),
      },
      subscription: {
        stripeSubId: sub?.stripeSubId ?? null,
        status: !hasLiveSubscription ? "none" : sub?.cancelAtPeriodEnd ? "canceling" : "active",
        periodEnd: sub?.periodEnd ?? null,
        billingInterval: sub?.billingInterval ?? null,
      },
    };
  }

  /**
   * Set or clear a tenant's custom price override. SA-733 D8: STRIPE FIRST — a live subscription is
   * repriced before the row is written, so a Stripe failure leaves the old fee untouched (503) and a
   * local failure after Stripe succeeded puts Stripe back. `dto.effective` picks the proration mode:
   * `next_cycle` (default) = `none`, `now_prorated` = `create_prorations`.
   */
  async updateTenantPriceOverride(id: string, dto: UpdateTenantPriceDto, adminId: string | null) {
    // One writer per tenant price (Postgres advisory lock, held across the Stripe calls): two overlapping
    // changes, a double submit and the plan-price fan-out can no longer interleave their Stripe updates.
    return underTenantPriceLock(id, () => this.updateTenantPriceOverrideLocked(id, dto, adminId));
  }

  private async updateTenantPriceOverrideLocked(
    id: string,
    dto: UpdateTenantPriceDto,
    adminId: string | null,
  ) {
    await this._findOrThrow(id);

    // Reject BEFORE writing when the resulting state has no resolvable monthly price
    // (e.g. clearing the custom fee on an ENTERPRISE/isCustom plan with no catalog
    // price). Writing first and failing on the follow-up resolve would delete the
    // negotiated fee, leave Stripe billing the old amount, and tell the admin it failed.
    const existing = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: id },
      select: {
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        planKey: true,
        basePriceSnapshot: true,
        updatedAt: true,
        downgradeToPlanKey: true, // R1 Option B: an early pre-renewal push may have lowered Stripe's price
        stripeSubId: true,
      },
    });
    const nextMonthly =
      dto.monthly === undefined ? (existing?.priceOverrideMonthly ?? null) : dto.monthly;
    if (nextMonthly == null) {
      // Throws BadRequestException when the catalog can't price this tenant's plan.
      await this.platformPricingService.resolveCatalogPricing(id);
    }

    // R1 Option B: if a pre-renewal push already moved Stripe onto a scheduled downgrade's LOWER price, put the
    // current plan's price back FIRST - the override then applies (and prorates, if asked) from the right price,
    // and the renewal is not left on the lowered one. Fails closed (throws) before anything else is sent.
    if (existing?.stripeSubId && existing.downgradeToPlanKey) {
      await this.scheduledPrice?.restoreIfPushedLocked(id, existing.downgradeToPlanKey, {
        mustBeCleared: false,
        audience: "admin",
      });
    }

    const effective = dto.effective ?? "next_cycle";
    const before = await this.platformPricingService.resolveTenantPricing(id).catch(() => null);
    const proposed = mergeOverride(existing, dto);
    const pushed = await this.billingService.pushResolvedPriceToStripe(id, {
      effective,
      proposed,
      version: existing?.updatedAt,
    });
    if (isPricePushFailure(pushed)) {
      // Stripe may still have applied it (a lost response is re-read, but a cached idempotent failure
      // is not): check the subscription in Stripe before retrying.
      throw new ServiceUnavailableException(
        `Stripe did not confirm the price change (${pushed.reason}) — the price override was NOT saved. ` +
          `Check the subscription in Stripe, then retry.`,
      );
    }

    // A custom-priced plan applied BEFORE its negotiated fee was entered leaves
    // `basePriceSnapshot` null (updatePlan's fallback has nothing to resolve), so MRR
    // books this tenant's add-ons with a $0 base. Entering the fee is the moment the
    // base becomes known: back-fill the snapshot and emit the run-rate delta in the
    // same transaction, mirroring updatePlan's PLAN_CHANGED emission. Only the
    // null-snapshot case back-fills — a set snapshot is already-reconciled data
    // (reconcilePriceLedger, called via syncStripeSubscriptionPrice below, rewrites it).
    const localWrite = this.prisma.$transaction(async (tx) => {
      // B864 / SA-277 (SA-163 shape): lock → read paying-set inputs → decide; a racing
      // activation serialises here.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
      // FIX-7 / SA-277: re-read the subscription (planKey AND basePriceSnapshot) UNDER the
      // lock — `backfillBase` must be decided from THIS locked read, never from the pre-tx
      // `existing` read above, or a racing activation that wrote the snapshot between the
      // pre-tx read and this lock would be clobbered/double-booked.
      const row = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          class: true,
          deletedAt: true,
          subscription: {
            select: {
              planKey: true,
              basePriceSnapshot: true,
              priceOverrideMonthly: true,
              priceOverrideAnnual: true,
            },
          },
        },
      });
      // D8: Stripe was repriced from the pre-tx read - a fee that moved since (a stray writer that skipped the
      // price lock: a direct SQL edit, a script, or a code path that forgot it) is refused here; the catch below
      // re-syncs Stripe from the committed row.
      if (!sameOverride(row.subscription, existing)) {
        throw new ConflictException(
          "The tenant's price override changed while this update was in flight — reload and retry.",
        );
      }
      const backfillBase =
        dto.monthly != null &&
        row.subscription?.planKey != null &&
        row.subscription.basePriceSnapshot == null;
      await tx.tenantSubscription.upsert({
        where: { tenantId: id },
        update: {
          priceOverrideMonthly: dto.monthly === undefined ? undefined : dto.monthly,
          priceOverrideAnnual: dto.annual === undefined ? undefined : dto.annual,
          ...(backfillBase ? { basePriceSnapshot: dto.monthly } : {}),
        },
        create: {
          tenantId: id,
          priceOverrideMonthly: dto.monthly ?? null,
          priceOverrideAnnual: dto.annual ?? null,
        },
      });
      // Snapshot written regardless; ONLY the emit is gated — a non-paying tenant books
      // once, at activation.
      if (backfillBase && isPayingRow(row, row.subscription?.planKey ?? null)) {
        await this.billingEventService.emit(
          id,
          BILLING_EVENTS.PLAN_CHANGED,
          {
            toPlan: row.subscription?.planKey ?? null,
            platformAdmin: true,
            priceOverrideBackfill: true,
          },
          { amountDelta: roundMoney(dto.monthly!), actorId: adminId, tx },
        );
      }
    });
    try {
      await localWrite;
    } catch (err) {
      // true = the committed row already holds the proposed fee (a lost commit ack): the write is in.
      if (
        !(await this.settleStripeAfterFailedWrite(id, adminId, { proposed, pushed, effective }))
      ) {
        throw err;
      }
    }

    const pricing = await this.platformPricingService.resolveTenantPricing(id);
    // The audit row goes BEFORE the ledger half: the price has changed, so an admin must never get a 500
    // with no audit trail. The ledger converges on the next sync if its half fails.
    await this.recordAdminAction(
      id,
      adminId,
      AdminAuditAction.TENANT_CONFIG_UPDATED,
      priceOverrideAudit({ dto, effective, before, after: pricing, sync: pushed }),
    );
    try {
      await this.billingService.syncStripeSubscriptionPrice(id, { pushed });
    } catch (e) {
      this.logger.error(
        `Price-override ledger reconcile failed for tenant ${id} (the next sync converges): ${(e as Error).message}`,
      );
    }

    return { ...pricing, sync: pushed };
  }

  /**
   * The local write failed AFTER Stripe was repriced. Never restore a remembered amount (another writer
   * may have committed since): read the COMMITTED row and bring Stripe to it. Returns true when the row
   * already holds the proposed fee; false after Stripe is back in line with the committed row (the caller
   * rethrows the original error). If Stripe cannot be brought back, the HTTP error says so, distinctly.
   */
  private async settleStripeAfterFailedWrite(
    id: string,
    adminId: string | null,
    a: {
      proposed: ProposedOverride;
      pushed: PricePushResult;
      effective: PriceOverrideEffective;
    },
  ): Promise<boolean> {
    let committed: {
      priceOverrideMonthly: unknown;
      priceOverrideAnnual: unknown;
      updatedAt: Date;
    } | null = null;
    try {
      committed = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId: id },
        select: { priceOverrideMonthly: true, priceOverrideAnnual: true, updatedAt: true },
      });
      if (
        committed &&
        sameOverride(committed, {
          priceOverrideMonthly: a.proposed.monthly,
          priceOverrideAnnual: a.proposed.annual,
        })
      ) {
        return true;
      }
    } catch {
      committed = null; // the database is unreachable: Stripe cannot be matched to it
    }
    if (!a.pushed.synced || a.pushed.unchanged) return false; // Stripe was never moved by this request
    if (committed) {
      const resync = await this.billingService
        .pushResolvedPriceToStripe(id, {
          // The same proration mode as the push, so a create_prorations change nets itself out.
          effective: a.pushed.proration === "create_prorations" ? "now_prorated" : "next_cycle",
          version: committed.updatedAt,
        })
        .catch(() => null);
      if (resync?.synced) return false;
    }
    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_CONFIG_UPDATED, {
      kind: "price_override_stripe_ahead",
      effective: a.effective,
      ...a.pushed,
    }).catch(() => undefined);
    this.logger.error(
      `Price override for tenant ${id}: Stripe now bills ${a.pushed.newAmount} but the database was not updated and Stripe could not be re-synced`,
    );
    throw new BadGatewayException({
      code: API_ERROR_CODES.PRICE_OVERRIDE_STRIPE_AHEAD,
      message:
        `Stripe now bills $${a.pushed.newAmount}, the database still says $${a.pushed.oldAmount ?? "?"} - ` +
        `reconcile the subscription price before changing it again.`,
    });
  }

  /**
   * Edit the CURRENT (latest published) PlanVersion's catalog price for one plan
   * key, then best-effort fans out `syncStripeSubscriptionPrice` to every tenant
   * on that plan key whose subscription has no price override and whose pinned
   * version IS that latest version — overrides and grandfathered (older-version)
   * tenants keep their own pricing untouched.
   */
  async updatePlanPrices(planKeyParam: string, dto: UpdatePlanPricesDto, adminId: string | null) {
    const planKey = normalizePlanKey(planKeyParam);
    if (!planKey) {
      throw new BadRequestException(`Unknown plan key "${planKeyParam}"`);
    }

    const version = await this.planCatalogService.getPublishedVersion();
    if (!version) {
      throw new NotFoundException(
        "No published plan catalog exists. Seed the billing catalog first.",
      );
    }
    const definition = version.definitions.find((d) => normalizePlanKey(d.planKey) === planKey);
    if (!definition) {
      throw new NotFoundException(`Plan ${planKey} not found in the current catalog version`);
    }

    const annualPrice =
      dto.annual === undefined
        ? new Prisma.Decimal(dto.monthly).mul(10)
        : dto.annual === null
          ? null
          : dto.annual;

    const updated = await this.prisma.planDefinition.update({
      where: { planVersionId_planKey: { planVersionId: version.id, planKey: definition.planKey } },
      data: { monthlyPrice: dto.monthly, annualPrice },
    });

    // Fan-out targets: tenants that actually resolve against THIS (latest) version for
    // this plan key and have no custom MONTHLY fee of their own.
    //   • `planVersionId: null` is included on purpose — PlanCatalogService.
    //     getVersionForTenant(null) resolves to the PUBLISHED version, so an unpinned
    //     tenant IS priced from this catalog row. Every Stripe-checkout tenant is
    //     unpinned (only self-service subscribe/upgrade ever writes the pin), so
    //     matching on `planVersionId: version.id` alone reaches no live subscription
    //     at all and a catalog price edit would never leave the database.
    //   • Only `priceOverrideMonthly` disqualifies: a tenant with an annual-only custom
    //     fee still takes its monthly from the catalog, so it must be re-synced too.
    const candidates = await this.prisma.tenantSubscription.findMany({
      where: {
        priceOverrideMonthly: null,
        tenant: {
          deletedAt: null,
          OR: [{ planVersionId: version.id }, { planVersionId: null }],
        },
      },
      select: {
        tenantId: true,
        planKey: true,
        downgradeToPlanKey: true,
        tenant: { select: { plan: true } },
      },
    });
    const onPlan = candidates.filter(
      (c) => normalizePlanKey(c.planKey ?? c.tenant.plan) === planKey,
    );
    // N3 (R1 Option B): a tenant whose scheduled DOWNGRADE price has ALREADY been pushed onto its Stripe base item
    // (ScheduledPriceChangeService, before the renewal) must not be synced here: that would price Stripe from the
    // plan it is LEAVING and revert the push, so the renewal bills the old plan again. Only THOSE tenants are
    // skipped (decided per tenant under its lock below). A tenant with a downgrade scheduled but not yet pushed is
    // synced like any other - otherwise a downgrade cancelled later would leave Stripe on the pre-update price.
    const targets = onPlan;
    let skippedDowngrade = 0;

    let synced = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        // The same per-tenant price lock the override flow takes, so the fan-out cannot overwrite an
        // override Stripe update that has not committed yet.
        const result = await underTenantPriceLock(target.tenantId, async () => {
          // Decided UNDER the lock, from a fresh read: has the scheduled downgrade's price been pushed already?
          const armed = await this.prisma.tenantSubscription.findUnique({
            where: { tenantId: target.tenantId },
            select: { downgradeToPlanKey: true },
          });
          // (Without the scheduled-price service a scheduled downgrade is skipped - the conservative answer.)
          if (
            armed?.downgradeToPlanKey &&
            ((await this.scheduledPrice?.isDowngradePricePushed(target.tenantId)) ?? true)
          ) {
            this.logger.log(
              `Plan price fan-out: tenant ${target.tenantId} skipped - its downgrade to ${armed.downgradeToPlanKey} price is already pushed to Stripe`,
            );
            return "skipped" as const;
          }
          return this.billingService.syncStripeSubscriptionPrice(target.tenantId);
        });
        if (result === "skipped") skippedDowngrade++;
        else if (result?.synced) synced++;
      } catch (e) {
        failed++;
        this.logger.warn(
          `Plan price fan-out sync failed for tenant ${target.tenantId}: ${(e as Error).message}`,
        );
      }
    }

    await this.auditService.log({
      tenantId: null,
      userId: adminId,
      action: "PLAN_PRICES_UPDATED",
      entityType: "plan_definition",
      entityId: definition.id,
      meta: {
        platformAdmin: true,
        planKey,
        monthlyPrice: dto.monthly,
        annualPrice: annualPrice === null ? null : Number(annualPrice),
        updated: targets.length - skippedDowngrade,
        synced,
        failed,
        skippedDowngrade,
      },
    });

    return {
      planKey,
      monthlyPrice: Number(updated.monthlyPrice),
      annualPrice: updated.annualPrice === null ? null : Number(updated.annualPrice),
      updated: targets.length - skippedDowngrade,
      synced,
      failed,
      skippedDowngrade,
    };
  }

  // ─── Trial extension ─────────────────────────────────────────────────────────

  async extendTrial(id: string, days: number, adminId: string | null = null) {
    await this._findOrThrow(id);
    // An ACTIVE tenant is a paying tenant: extending a "trial" would silently demote it. The status
    // predicate is part of the write itself (no read-then-write gap): count 0 = it is ACTIVE.
    const { count } = await this.prisma.tenant.updateMany({
      where: { id, status: { not: "ACTIVE" } },
      data: {
        trialEndsAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        status: "TRIAL",
      },
    });
    if (count === 0) throw activeTenantTrialRefusal();
    const updated = await this.prisma.tenant.findUniqueOrThrow({
      where: { id },
      select: { id: true, slug: true, trialEndsAt: true, status: true },
    });
    // Evict cached status so the guard picks up the reactivation immediately
    this.tenantStatusGuard.invalidate(id);
    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_TRIAL_EXTENDED, {
      days,
      trialEndsAt: updated.trialEndsAt,
    });
    return updated;
  }

  // ─── Reset tenant admin password ─────────────────────────────────────────────

  async resetTenantAdminPassword(tenantId: string, adminId: string | null = null) {
    await this._findOrThrow(tenantId);
    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
    });
    if (!adminUser) throw new NotFoundException("No active TENANT_ADMIN found for this tenant");

    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    await this.prisma.user.update({
      where: { id: adminUser.id },
      data: { password: hashedPassword, forcePasswordChange: true },
    });
    await this.recordAdminAction(tenantId, adminId, AdminAuditAction.TENANT_ADMIN_PASSWORD_RESET, {
      username: adminUser.username,
      userId: adminUser.id,
    });
    return { username: adminUser.username, tempPassword };
  }

  // ─── Audit logs ───────────────────────────────────────────────────────────────

  async getAuditLogs(
    filters: {
      tenantId?: string | null;
      action?: string | null;
      entityType?: string | null;
      userId?: string | null;
      from?: string | null;
      to?: string | null;
    },
    page = 1,
    limit = 50,
  ) {
    const skip = (page - 1) * limit;
    const where: Record<string, unknown> = {};
    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.action) where.action = filters.action;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.userId) where.userId = filters.userId;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }
    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    // Resolve actor + tenant display names for this page so the UI shows
    // "maria@goldenstate.co" / "Golden State Distribution" instead of raw UUIDs.
    const userIds = [...new Set(logs.map((l) => l.userId).filter((x): x is string => !!x))];
    const tenantIds = [...new Set(logs.map((l) => l.tenantId).filter((x): x is string => !!x))];
    // Prisma returns [] for an empty `in`, so these are safe (and cheap) even with no ids.
    const [users, tenants] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, email: true, role: true },
      }),
      this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, slug: true, name: true },
      }),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u] as const));
    const tenantMap = new Map(tenants.map((t) => [t.id, t] as const));

    const data = logs.map((log) => {
      const u = log.userId ? userMap.get(log.userId) : undefined;
      const t = log.tenantId ? tenantMap.get(log.tenantId) : undefined;
      return {
        ...log,
        actionLabel: adminAuditActionLabel(log.action),
        actor: u
          ? { id: u.id, username: u.username, email: u.email, isPlatform: u.role === "SUPER_ADMIN" }
          : null,
        tenant: t ? { id: t.id, slug: t.slug, name: t.name } : null,
      };
    });

    return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /** Known admin action codes + labels for the audit-log filter dropdown. */
  getAuditLogFacets() {
    return { actions: ADMIN_AUDIT_ACTION_FACETS };
  }

  // ─── Entitlements ─────────────────────────────────────────────────────────────

  /**
   * What a tenant actually has, server-authoritative: resolved flags/addons/caps
   * + planKey (from {@link EntitlementsService}) plus live meter usage. The first
   * admin-facing way to see this without querying the DB directly.
   */
  async getTenantEntitlements(tenantId: string) {
    await this._findOrThrow(tenantId);
    const [entitlements, usage, overrides] = await Promise.all([
      this.entitlementsService.resolve(tenantId),
      this.meterService.readAll(tenantId),
      this.featureOverrides.allActive(tenantId),
    ]);

    // Opus review of 8130b204, item 4: this admin-facing entitlements view must agree with the
    // tenant's own Overrides table -- same RequirePlanFlag-filtered merge as
    // SubscriptionService.getSubscription. `entitlements.addons` is SKU codes ("REGULATED_ITEMS"),
    // a different namespace from a feature-registry addon KEY ("tobacco_dealer") -- unlike
    // tenants.controller.ts's getMyAddons, whose `addons` array IS addonKey-shaped, there is no
    // unambiguous key->SKU mapping to merge a GRANT/DENY into here, so it stays untouched.
    const flags = new Set(entitlements.flags);
    for (const [key, effect] of overrides) {
      if (gateVia(key) !== "RequirePlanFlag") continue;
      if (effect === "GRANT") flags.add(key);
      else flags.delete(key);
    }

    return {
      planKey: entitlements.planKey,
      flags: Array.from(flags),
      addons: entitlements.addons,
      caps: entitlements.caps,
      usage,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async _findOrThrow(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return tenant;
  }

  /**
   * SA-140 (B556): the one place "what plan is this tenant on, for display" is resolved —
   * `getStats()`'s planCounts breakdown and `_formatTenant()` (behind BOTH listTenants() and
   * getTenant()) now share this instead of each carrying its own copy (planCounts already had
   * the correct planKey-first/legacy-fallback logic; `_formatTenant()`'s `plan` field never
   * consulted `subscription.planKey` at all — the literal mechanism behind B556's original
   * evidence: a tenant with a real `Tenant.plan` but no resolved `planKey`, shown with the
   * legacy plan's badge while contributing $0 to MRR). Callers must select
   * `subscription: { select: { planKey: true, ... } }` — a caller whose select never fetches it
   * silently resolves the fallback for every row (L-169).
   */
  private _resolveDisplayPlanKey(t: {
    plan: TenantPlan;
    subscription?: { planKey: string | null } | null;
  }): string {
    return normalizePlanKey(t.subscription?.planKey) ?? planKeyFromEnum(t.plan);
  }

  private _formatTenant(t: any) {
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      // SA-140 (B556): `plan` keeps its existing shape (the raw legacy TenantPlan enum) for
      // compatibility with existing consumers — `planKey` is ADDED alongside it, resolved
      // through the subscription first (resolveDisplayPlanKey). #2045: a drifted tenant
      // (Tenant.plan set, subscription.planKey null) still shows a plan badge here — the
      // resolver falls back to the legacy enum — so this field alone does NOT reveal the drift;
      // MRR, which requires a subscription planKey, is what excludes such a row.
      plan: t.plan,
      planKey: this._resolveDisplayPlanKey(t),
      trialEndsAt: t.trialEndsAt,
      createdAt: t.createdAt,
      deletedAt: t.deletedAt,
      businessName: t.config?.businessName ?? null,
      primaryColor: t.config?.primaryColor ?? null,
      logoKey: t.config?.logoKey ?? null,
      addressLine1: t.config?.addressLine1 ?? null,
      city: t.config?.city ?? null,
      state: t.config?.state ?? null,
      zip: t.config?.zip ?? null,
      country: t.config?.country ?? null,
      phone: t.config?.phone ?? null,
      subscription: t.subscription ?? null,
      counts: t._count ?? null,
    };
  }

  async updateTenantConfig(
    tenantId: string,
    dto: UpdateTenantConfigDto,
    adminId: string | null = null,
  ) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    await this.prisma.tenantConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...dto },
      update: dto,
    });

    await this.recordAdminAction(tenantId, adminId, AdminAuditAction.TENANT_CONFIG_UPDATED, {
      fields: Object.keys(dto),
    });

    try {
      await this.tenantMirror.upsert(tenantId);
    } catch (err) {
      this.logger.debug(`Mirror sync not updated for ${tenantId}: ${(err as Error).message}`);
    }

    return this.getTenant(tenantId);
  }

  // ─── Tenant admin management ──────────────────────────────────────────────────

  async getTenantAdmin(tenantId: string) {
    await this._findOrThrow(tenantId);
    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", deletedAt: null },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        createdAt: true,
        forcePasswordChange: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return { admin: adminUser ?? null };
  }

  async createTenantAdmin(
    tenantId: string,
    dto: CreateTenantAdminDto,
    adminId: string | null = null,
  ) {
    await this._findOrThrow(tenantId);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true },
    });

    // Check that no TENANT_ADMIN already exists
    const existing = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
    });
    if (existing) {
      throw new ConflictException("This tenant already has an active admin account");
    }

    // Check username/email uniqueness within the tenant
    const collision = await this.prisma.user.findFirst({
      where: { tenantId, OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (collision)
      throw new BadRequestException("Username or email already in use for this tenant");

    const autoGenerated = !dto.password;
    const rawPassword =
      dto.password ??
      `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        password: hashedPassword,
        role: "TENANT_ADMIN",
        status: "ACTIVE",
        forcePasswordChange: autoGenerated,
        tenantId,
        // Owner decision 2026-08-28: admins are NOT drivers by default — see createTenant.
        canActAsDriver: false,
      },
      select: { id: true, username: true, email: true, status: true, createdAt: true },
    });

    // Send welcome email
    try {
      await this.emailService.send({
        to: dto.email,
        subject: `Your RouteFlow admin account for ${tenant?.name ?? tenantId}`,
        html: `<p>Hello ${escapeHtml(dto.username)},</p>
<p>A platform administrator has created an admin account for you on <strong>${escapeHtml(tenant?.name ?? tenantId)}</strong>.</p>
<p><strong>Username:</strong> ${escapeHtml(dto.username)}<br/>
<strong>Password:</strong> ${escapeHtml(rawPassword)}</p>
<p><em>Please log in and change your password immediately.</em></p>
<p>RouteFlow Platform</p>`,
        // email-connect-google PR-3: contains a password — platform sender only, never a
        // tenant mailbox/SMTP.
        senderClass: "platform",
      });
    } catch {
      /* best-effort */
    }

    await this.recordAdminAction(tenantId, adminId, AdminAuditAction.TENANT_ADMIN_CREATED, {
      username: user.username,
      userId: user.id,
    });

    return { ...user, ...(autoGenerated ? { tempPassword: rawPassword } : {}) };
  }

  /**
   * Manual override of a tenant's classification (production/demo/test/internal) — distinct
   * from the automated slug-derived backfill (classifyTenantSlug / Task 3's dark script): this
   * takes an explicit target class from the admin, not a derived one. A transition into or out
   * of PRODUCTION changes what MrrService counts as revenue, so it also emits one BillingEvent
   * (tenant.class_changed) for traceability — every other transition (e.g. TEST -> DEMO) is
   * audit-logged but does not move the MRR ledger and emits nothing.
   */
  async updateTenantClass(
    tenantId: string,
    dto: UpdateTenantClassDto,
    adminId: string | null = null,
  ) {
    // The tenant update and the BillingEvent emit must land or roll back together: a class
    // flip that crosses the PRODUCTION boundary without its BillingEvent would leave
    // MrrService's ledger silently out of sync with the tenant table. recordAdminAction stays
    // OUTSIDE the transaction (below) — it doesn't accept a Prisma client (see its signature
    // above) and is fire-and-forget by design (AuditService.log swallows its own errors).
    const { result: updated, before } = await this.prisma.$transaction(async (tx) => {
      // SA-140: lock first, same reasoning as updateStatus() — a concurrent write to this same
      // tenant (a status change, a price resync) must not interleave with the read-then-decide
      // logic below.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
      // #2045: the class the PRODUCTION-boundary decision is made from is read UNDER that lock —
      // read before it, a concurrent class flip committing in between would make this call book
      // (or skip) the class_changed rebase against a stale class.
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, slug: true, class: true },
      });

      const result = await tx.tenant.update({
        where: { id: tenantId },
        data: { class: dto.class },
        select: { id: true, slug: true, class: true },
      });

      const wasProd = before.class === "PRODUCTION";
      const isProd = dto.class === "PRODUCTION";
      if (wasProd !== isProd) {
        // SA-140 (B557 item 2): ledgerAgg (mrr.service.ts) sums BillingEvent.amountDelta
        // WHERE tenant.class = 'PRODUCTION' — a join evaluated against the tenant's CURRENT
        // class, not class-at-event-time. The moment a tenant enters PRODUCTION, its entire
        // pre-existing amountDelta history (booked under whatever class it had before) becomes
        // visible to that SUM in one step, with nothing compensating for the import.
        //
        // Entering PRODUCTION: emit a compensating delta = this tenant's LIVE contribution
        // right now, minus the Σ of everything it's about to import — so its post-flip ledger
        // contribution lands exactly at its live `mrr` contribution, matching `mrr` at the
        // instant of the transition instead of importing unrelated pre-PRODUCTION history.
        // priceTenant() MUST be called with `tx`, AFTER the class write above: it gates on
        // `tenant.class` itself (mrr.service.ts), and a call without `tx` (or before this
        // write commits) would still see the OLD class under read-committed isolation and
        // silently return 0 — understating the compensation with no error (SA-140).
        //
        // Leaving PRODUCTION: no compensating entry needed. ledgerAgg's current-class join
        // automatically excludes ALL of this tenant's BillingEvent rows (past and future) the
        // instant `class` flips away from PRODUCTION — the same reason isPayingRow's `class`
        // condition drops it from live `mrr` at the same moment. Both go to zero contribution
        // together, for the same underlying reason.
        let amountDelta: number | undefined;
        if (isProd) {
          const [priorSum, liveContribution] = await Promise.all([
            tx.billingEvent.aggregate({ _sum: { amountDelta: true }, where: { tenantId } }),
            this.mrrService.priceTenant(tenantId, tx),
          ]);
          amountDelta = roundMoney(liveContribution - Number(priorSum._sum.amountDelta ?? 0));
        }
        await this.billingEventService.emit(
          tenantId,
          BILLING_EVENTS.TENANT_CLASS_CHANGED,
          { from: before.class, to: dto.class, reason: dto.reason, platformAdmin: true },
          { amountDelta, actorId: adminId, tx },
        );
      }

      return { result, before };
    });

    await this.recordAdminAction(tenantId, adminId, AdminAuditAction.TENANT_CLASS_CHANGED, {
      from: before.class,
      to: dto.class,
      reason: dto.reason,
    });

    return updated;
  }
}

/** False for a missing/unparseable base URL or one that points at this machine (#2439). */
export function isPublicWebBase(webBase: string): boolean {
  let host: string;
  try {
    host = new URL(webBase).hostname.toLowerCase();
  } catch {
    return false;
  }
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}
