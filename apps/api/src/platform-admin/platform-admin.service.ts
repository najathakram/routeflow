import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { TenantStatus, TenantPlan, Prisma } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { PlatformPricingService } from "../billing/platform-pricing.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { MeterService } from "../billing/meter.service";
import { BillingEventService } from "../billing/billing-event.service";
import {
  normalizePlanKey,
  planKeyFromEnum,
  findPlanDefinition,
  BILLING_EVENTS,
} from "../billing/plan-catalog.constants";
import { roundMoney } from "@routeflow/pricing";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AppConfig } from "../config/configuration";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { IRS_SYSTEM_CATEGORIES } from "../bookkeeping/irs-categories.constant";
import { ActivateSubscriptionDto } from "./dto/activate-subscription.dto";
import { UpdateTenantConfigDto } from "./dto/update-tenant-config.dto";
import { UpdateTenantPriceDto } from "./dto/update-tenant-price.dto";
import { UpdatePlanPricesDto } from "./dto/update-plan-prices.dto";
import { AuditService } from "../audit/audit.service";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY,
  ADMIN_AUDIT_ACTION_FACETS,
  adminAuditActionLabel,
  type AdminAuditActionCode,
} from "./audit-actions.constant";

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
    private readonly entitlementsService: EntitlementsService,
    private readonly billingEventService: BillingEventService,
    private readonly meterService: MeterService,
    private readonly tenantStatusGuard: TenantStatusGuard,
    private readonly auditService: AuditService,
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
    tenantId: string,
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
    if (filters.plan) where.plan = filters.plan;
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
            select: { currentPlan: true, periodEnd: true, cancelAtPeriodEnd: true },
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
    const [tenant, orders30d, catalogPriceByPlanKey] = await Promise.all([
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
            },
          },
        },
      }),
      // Read-only order count (orders module untouched); raw client is correct
      // here since a super-admin request carries no tenant scope.
      this.prisma.order.count({ where: { tenantId: id, createdAt: { gte: thirtyDaysAgo } } }),
      this._catalogPriceByPlanKey(),
    ]);
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return {
      ...this._formatTenant(tenant),
      orders30d,
      // Only an ACTIVE tenant is paying; trials/suspended/cancelled contribute $0.
      estMrrUsd:
        tenant.status === "ACTIVE"
          ? roundMoney(this._monthlyPriceUsd(tenant, catalogPriceByPlanKey))
          : 0,
    };
  }

  // ─── Create / Delete Tenant ───────────────────────────────────────────────────

  async createTenant(dto: CreateTenantDto, adminId: string | null = null) {
    const { slug, businessName, adminEmail, adminUsername, plan } = dto;

    const RESERVED_SLUGS = ["admin", "api", "app", "www", "platform", "auth", "health", "static"];
    if (RESERVED_SLUGS.includes(slug.toLowerCase()))
      throw new ConflictException(`Slug "${slug}" is reserved and cannot be used`);

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugTaken) throw new ConflictException(`Slug "${slug}" is already taken`);

    // Auto-generate a secure temporary password if none provided
    const tempPassword =
      dto.adminPassword ??
      `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const autoGenerated = !dto.adminPassword;

    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const tenantPlan = (plan as TenantPlan) ?? TenantPlan.STARTER;

    // Default trial: 7 days from now
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: businessName,
          status: "TRIAL",
          plan: tenantPlan,
          trialEndsAt,
        },
      });

      await tx.tenantConfig.create({ data: { tenantId: tenant.id, businessName } });

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
      if (existingUser) throw new BadRequestException("Email or username already in use");

      const user = await tx.user.create({
        data: {
          email: adminEmail,
          username: adminUsername,
          password: hashedPassword,
          role: "TENANT_ADMIN",
          status: "ACTIVE",
          forcePasswordChange: autoGenerated, // force change if password was auto-generated
          tenantId: tenant.id,
          // Owner decision 2026-08-28: admins are NOT drivers by default — driver capability
          // is an explicit opt-in via Settings → Act as driver
          // (users.service.toggleDriverPermit), which creates the Driver row on first enable.
          canActAsDriver: false,
        },
      });

      return { tenant, user };
    });

    // Create Stripe customer + checkout URL (best-effort — only if Stripe is configured)
    let checkoutUrl: string | null = null;
    try {
      const { checkoutUrl: url } = await this.billingService.createCheckoutSession(
        result.tenant.id,
      );
      checkoutUrl = url;
    } catch (err) {
      // Stripe not configured or price not set — checkout URL won't be available
      this.logger.debug(`Checkout session not created for ${slug}: ${(err as Error).message}`);
    }

    // Send welcome email with credentials and optional payment link (best-effort)
    try {
      const paymentSection = checkoutUrl
        ? `<p><strong>Complete your subscription:</strong><br/>
<a href="${checkoutUrl}">${checkoutUrl}</a></p>`
        : "";

      await this.emailService.send({
        to: adminEmail,
        subject: `Welcome to RouteFlow — Your ${businessName} account is ready`,
        html: `<p>Hello ${adminUsername},</p>
<p>Your RouteFlow account for <strong>${businessName}</strong> has been created.</p>
<p><strong>Username:</strong> ${adminUsername}<br/>
<strong>Temporary Password:</strong> ${tempPassword}</p>
${autoGenerated ? "<p><em>Please log in and change your password immediately.</em></p>" : ""}
${paymentSection}
<p>Your trial expires in 7 days. Complete payment to continue using RouteFlow.</p>
<p>RouteFlow Platform</p>`,
      });
    } catch {
      /* best-effort — don't fail tenant creation over email */
    }

    await this.recordAdminAction(result.tenant.id, adminId, AdminAuditAction.TENANT_CREATED, {
      slug: result.tenant.slug,
      plan: result.tenant.plan,
      adminUsername: result.user.username,
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
      ...(autoGenerated ? { tempPassword } : {}),
      ...(checkoutUrl ? { checkoutUrl } : {}),
    };
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
    // B216: captured BEFORE the write so we can tell a REAL non-ACTIVE→ACTIVE transition (an
    // admin reactivation) from an already-ACTIVE tenant being set ACTIVE again. Only fetched when
    // the target is ACTIVE — the other transitions never need it.
    const wasActive =
      dto.status === "ACTIVE"
        ? (await this.prisma.tenant.findUnique({ where: { id }, select: { status: true } }))
            ?.status === "ACTIVE"
        : false;
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: { status: dto.status },
    });
    // Evict cached status so the guard picks up the change immediately
    this.tenantStatusGuard.invalidate(id);
    const action =
      dto.status === "SUSPENDED"
        ? AdminAuditAction.TENANT_SUSPENDED
        : dto.status === "ACTIVE"
          ? AdminAuditAction.TENANT_REACTIVATED
          : AdminAuditAction.TENANT_STATUS_CHANGED;
    await this.recordAdminAction(id, adminId, action, { status: tenant.status });

    // B216: a downgrade armed before a tenant lapsed must not survive reinstatement and fire later
    // against a paying tenant. The Stripe-webhook reinstatement paths already clear it via
    // billing.service.ts's disarmedDowngrade(), guarded on a real non-ACTIVE→ACTIVE CAS — this is
    // that same shape for the admin's non-Stripe reinstatement path. Not imported: disarmedDowngrade()
    // is a private module-level function in billing.service.ts, not exported, and this service has
    // no existing dependency on its internals to justify exporting it just for this — the field set
    // is replicated here with billing.service.ts's disarmedDowngrade() named as the source of truth.
    // Scoped to a REAL transition only (mirrors the webhook paths' CAS discipline): never fires for
    // an already-ACTIVE tenant re-set ACTIVE, or for a transition to any other status, so a
    // legitimately scheduled downgrade on a healthy tenant survives. cancelAtPeriodEnd is
    // deliberately left untouched — that flag is a cancellation, not a downgrade.
    if (dto.status === "ACTIVE" && !wasActive) {
      await this.prisma.tenantSubscription.updateMany({
        where: { tenantId: id },
        data: { downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] },
      });
    }

    return { id: tenant.id, slug: tenant.slug, status: tenant.status };
  }

  async updatePlan(id: string, dto: UpdateTenantPlanDto, adminId: string | null = null) {
    const before = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, plan: true, status: true },
    });
    if (!before) throw new NotFoundException(`Tenant ${id} not found`);

    // Resolve the target plan against the currently PUBLISHED PlanVersion so this write
    // stays consistent with SubscriptionMutationService.subscribe()
    // (subscription-mutation.service.ts:132-163) — planKey/planVersionId must always point
    // at a real catalog row, never just the legacy TenantPlan enum shadow.
    const targetPlanKey = planKeyFromEnum(dto.plan);
    const version = await this.planCatalogService.getPublishedVersion();
    if (!version) {
      throw new NotFoundException(
        "No published plan catalog exists. Seed the billing catalog first.",
      );
    }
    const definition = findPlanDefinition(version.definitions, targetPlanKey);
    if (!definition) {
      throw new NotFoundException(`Plan ${targetPlanKey} not found in the current catalog version`);
    }

    // Prior run-rate baseline — the MRR ledger books the signed CHANGE from this state.
    const priorSub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: id },
      select: {
        planKey: true,
        basePriceSnapshot: true,
        priceOverrideMonthly: true,
        discount: true,
      },
    });

    // A custom (Enterprise) definition has no catalog price — the tenant's negotiated fee
    // lives in `priceOverrideMonthly` instead. Writing `planKey` with a null snapshot would
    // enter the tenant in the rollup at $0 base while its active add-ons start counting
    // (mrr.service.ts:63-66), the "add-on MRR with no base behind it" that guard warns about.
    const baseSnapshot = definition.monthlyPrice ?? priorSub?.priceOverrideMonthly ?? null;

    // MrrService's paying predicate (mrr.service.ts:44-47): ACTIVE tenant with a non-null
    // planKey. This write always sets planKey, so an ACTIVE tenant is paying afterwards —
    // a manual/external activation (which deliberately leaves planKey null) CROSSES in here.
    const wasPaying = before.status === "ACTIVE" && priorSub?.planKey != null;
    const isPaying = before.status === "ACTIVE";

    const tenant = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id },
        data: { plan: dto.plan, planVersionId: version.id },
      });
      // Upsert subscription record to reflect plan change — the same catalog-derived
      // fields subscribe() writes, so entitlements resolution reads a consistent state
      // regardless of which mutation path last touched this tenant. `basePriceSnapshot`
      // must move WITH `planKey`: MrrService prices a tenant from the snapshot alone
      // (mrr.service.ts:82), so leaving it stale/null would book the old plan's price —
      // or $0 — under the new plan.
      await tx.tenantSubscription.upsert({
        where: { tenantId: id },
        create: {
          tenantId: id,
          currentPlan: dto.plan,
          planKey: definition.planKey,
          planVersionId: version.id,
          basePriceSnapshot: baseSnapshot,
        },
        update: {
          currentPlan: dto.plan,
          planKey: definition.planKey,
          planVersionId: version.id,
          basePriceSnapshot: baseSnapshot,
          // A committing plan write disarms any scheduled downgrade — the same invariant every
          // self-service writer holds (subscription-mutation.service.ts). Left armed, the 02:00
          // sweep (which filters on downgradeEffectiveAt alone, never on rank or current plan)
          // would silently undo this admin's change and deactivate the tenant's staff.
          // `cancelAtPeriodEnd` is deliberately NOT touched: an admin plan edit must not revoke
          // a cancellation the tenant asked for — that is resume()'s job.
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          retainedUserIds: [],
        },
      });

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
        },
        { amountDelta: roundMoney(nextContribution - priorContribution), actorId: adminId, tx },
      );
      return updated;
    });

    this.entitlementsService.invalidate(id);

    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_PLAN_CHANGED, {
      from: before.plan,
      to: tenant.plan,
    });
    return { id: tenant.id, slug: tenant.slug, plan: tenant.plan };
  }

  // ─── Manual subscription activation (non-Stripe payment) ─────────────────────

  async activateManualSubscription(
    id: string,
    dto: ActivateSubscriptionDto,
    adminId: string | null = null,
  ) {
    await this._findOrThrow(id);

    const now = new Date();
    const periodEnd = new Date(now.getTime() + dto.billingPeriodDays * 24 * 60 * 60 * 1000);

    const [tenant] = await Promise.all([
      this.prisma.tenant.update({
        where: { id },
        data: { status: "ACTIVE", plan: dto.plan },
        select: { id: true, slug: true, status: true, plan: true },
      }),
      this.prisma.tenantSubscription.upsert({
        where: { tenantId: id },
        create: {
          tenantId: id,
          currentPlan: dto.plan,
          periodStart: now,
          periodEnd,
          externalPayment: true,
          externalPaymentMethod: dto.paymentMethod,
          externalPaymentRef: dto.paymentRef ?? null,
          externalPaymentNotes: dto.notes ?? null,
        },
        update: {
          currentPlan: dto.plan,
          periodStart: now,
          periodEnd,
          // Rolling the period forward disarms every pending transition. A downgrade left armed
          // now points at the OLD (already past) period end, so the very next 02:00 sweep would
          // fire it against the subscription this admin just activated.
          cancelAtPeriodEnd: false,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          retainedUserIds: [],
          externalPayment: true,
          externalPaymentMethod: dto.paymentMethod,
          externalPaymentRef: dto.paymentRef ?? null,
          externalPaymentNotes: dto.notes ?? null,
        },
      }),
    ]);

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

    const [
      totalTenants,
      activeTenants,
      trialTenants,
      suspendedTenants,
      totalUsers,
      superAdminCount,
      newTenantsThisMonth,
      planScanRows,
      catalogPriceByPlanKey,
      recentTenants,
      trialsExpiringSoon,
      atRiskTenants,
    ] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { status: TenantStatus.ACTIVE } }),
      this.prisma.tenant.count({ where: { status: TenantStatus.TRIAL } }),
      this.prisma.tenant.count({ where: { status: TenantStatus.SUSPENDED } }),
      this.prisma.user.count({ where: { tenantId: { not: null } } }),
      this.prisma.user.count({ where: { role: "SUPER_ADMIN" } }),
      this.prisma.tenant.count({ where: { createdAt: { gte: startOfMonth } } }),
      // Plan distribution + Est. MRR share one scan: excludes cancelled/soft-deleted
      // tenants (hidden everywhere else). Keyed on the tenant's normalized planKey
      // (subscription.planKey, else the legacy `plan` enum mapped forward) below —
      // ACTIVE-only filtering for MRR happens in the reduce, not the query.
      this.prisma.tenant.findMany({
        where: { deletedAt: null, status: { not: TenantStatus.CANCELLED } },
        select: {
          status: true,
          plan: true,
          subscription: { select: { planKey: true, basePriceSnapshot: true } },
        },
      }),
      this._catalogPriceByPlanKey(),
      this.prisma.tenant.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        select: { id: true, slug: true, name: true, status: true, plan: true, createdAt: true },
      }),
      // Trials expiring within 7 days
      this.prisma.tenant.findMany({
        where: {
          status: TenantStatus.TRIAL,
          trialEndsAt: { lte: sevenDaysFromNow, gte: now },
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
          OR: [
            { status: TenantStatus.SUSPENDED },
            { status: TenantStatus.TRIAL, trialEndsAt: { lt: now } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, slug: true, name: true, status: true, plan: true, trialEndsAt: true },
      }),
    ]);

    // Plan distribution keyed on the current catalog's planKey (STARTER/GROWTH/
    // SCALE/ENTERPRISE), not the legacy `plan` enum shadow. Est. MRR sums only
    // ACTIVE tenants' real price: the subscription's pinned basePriceSnapshot
    // (grandfathered) when set, else the published catalog's monthlyPrice for the
    // tenant's normalized planKey, else $0.
    const planCounts: Record<string, number> = {};
    let mrrTotal = 0;
    for (const t of planScanRows) {
      const planKey = normalizePlanKey(t.subscription?.planKey) ?? planKeyFromEnum(t.plan);
      planCounts[planKey] = (planCounts[planKey] ?? 0) + 1;
      if (t.status === TenantStatus.ACTIVE) {
        mrrTotal += this._monthlyPriceUsd(t, catalogPriceByPlanKey);
      }
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
      estMrrUsd: roundMoney(mrrTotal),
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
      const count = await this.prisma.tenant.count({
        where: { createdAt: { gte: start, lt: end } },
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
    const [subscriptions, totalTenants, trialTenants] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        include: {
          tenant: {
            select: { id: true, slug: true, name: true, status: true, plan: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { status: TenantStatus.TRIAL } }),
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
   * Set or clear a tenant's custom price override, then sync any live Stripe
   * subscription to the new resolved price (owner decision: `proration_behavior:
   * "none"` — applies from the next billing cycle, never mid-period).
   */
  async updateTenantPriceOverride(id: string, dto: UpdateTenantPriceDto, adminId: string | null) {
    await this._findOrThrow(id);

    // Reject BEFORE writing when the resulting state has no resolvable monthly price
    // (e.g. clearing the custom fee on an ENTERPRISE/isCustom plan with no catalog
    // price). Writing first and failing on the follow-up resolve would delete the
    // negotiated fee, leave Stripe billing the old amount, and tell the admin it failed.
    const existing = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: id },
      select: { priceOverrideMonthly: true, planKey: true, basePriceSnapshot: true },
    });
    const nextMonthly =
      dto.monthly === undefined ? (existing?.priceOverrideMonthly ?? null) : dto.monthly;
    if (nextMonthly == null) {
      // Throws BadRequestException when the catalog can't price this tenant's plan.
      await this.platformPricingService.resolveCatalogPricing(id);
    }

    // A custom-priced plan applied BEFORE its negotiated fee was entered leaves
    // `basePriceSnapshot` null (updatePlan's fallback has nothing to resolve), so MRR
    // books this tenant's add-ons with a $0 base. Entering the fee is the moment the
    // base becomes known: back-fill the snapshot and emit the run-rate delta in the
    // same transaction, mirroring updatePlan's PLAN_CHANGED emission. Only the
    // null-snapshot case back-fills — a set snapshot is grandfathered data and an
    // override on top of it deliberately does not rewrite it.
    const backfillBase =
      dto.monthly != null && existing?.planKey != null && existing.basePriceSnapshot == null;
    await this.prisma.$transaction(async (tx) => {
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
      if (backfillBase) {
        await this.billingEventService.emit(
          id,
          BILLING_EVENTS.PLAN_CHANGED,
          { toPlan: existing.planKey, platformAdmin: true, priceOverrideBackfill: true },
          { amountDelta: roundMoney(dto.monthly!), actorId: adminId, tx },
        );
      }
    });

    const [sync, pricing] = await Promise.all([
      this.billingService.syncStripeSubscriptionPrice(id),
      this.platformPricingService.resolveTenantPricing(id),
    ]);

    await this.recordAdminAction(id, adminId, AdminAuditAction.TENANT_CONFIG_UPDATED, {
      kind: "price_override",
      monthly: dto.monthly ?? null,
      annual: dto.annual ?? null,
      sync,
    });

    return { ...pricing, sync };
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
      select: { tenantId: true, planKey: true, tenant: { select: { plan: true } } },
    });
    const targets = candidates.filter(
      (c) => normalizePlanKey(c.planKey ?? c.tenant.plan) === planKey,
    );

    let synced = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const result = await this.billingService.syncStripeSubscriptionPrice(target.tenantId);
        if (result?.synced) synced++;
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
        updated: targets.length,
        synced,
        failed,
      },
    });

    return {
      planKey,
      monthlyPrice: Number(updated.monthlyPrice),
      annualPrice: updated.annualPrice === null ? null : Number(updated.annualPrice),
      updated: targets.length,
      synced,
      failed,
    };
  }

  // ─── Trial extension ─────────────────────────────────────────────────────────

  async extendTrial(id: string, days: number, adminId: string | null = null) {
    await this._findOrThrow(id);
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        trialEndsAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        status: "TRIAL",
      },
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
    const [entitlements, usage] = await Promise.all([
      this.entitlementsService.resolve(tenantId),
      this.meterService.readAll(tenantId),
    ]);
    return {
      planKey: entitlements.planKey,
      flags: entitlements.flags,
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

  /** Monthly USD price per current-catalog planKey, from the published PlanVersion.
   *  Keys are normalized so a still-published legacy catalog (rows keyed TEAM/
   *  BUSINESS) answers the GROWTH/SCALE lookups callers make — otherwise every
   *  tenant on those plans would price at $0 until the new catalog is published.
   *  Empty map when the catalog is unseeded — callers treat a missing key as $0. */
  private async _catalogPriceByPlanKey(): Promise<Map<string, number>> {
    const version = await this.planCatalogService.getPublishedVersion();
    return new Map(
      (version?.definitions ?? []).map((d) => [
        normalizePlanKey(d.planKey) ?? d.planKey,
        d.monthlyPrice != null ? Number(d.monthlyPrice) : 0,
      ]),
    );
  }

  /**
   * Real monthly USD price for a tenant's subscription: the pinned
   * `basePriceSnapshot` (grandfathered price) when set, else the published
   * catalog's monthlyPrice for the tenant's normalized planKey, else $0 (unseeded
   * catalog, or a planKey the current catalog doesn't carry). Replaces the retired
   * STOPGAP_PLAN_MONTHLY_USD constant, which knew only STARTER/PROFESSIONAL/
   * ENTERPRISE and silently priced everything else — including GROWTH/SCALE — at $0.
   */
  private _monthlyPriceUsd(
    tenant: {
      plan: string;
      subscription: { planKey: string | null; basePriceSnapshot: Prisma.Decimal | null } | null;
    },
    catalogPriceByPlanKey: Map<string, number>,
  ): number {
    const snapshot = tenant.subscription?.basePriceSnapshot;
    if (snapshot != null) return Number(snapshot);
    const planKey = normalizePlanKey(tenant.subscription?.planKey) ?? planKeyFromEnum(tenant.plan);
    return catalogPriceByPlanKey.get(planKey) ?? 0;
  }

  private _formatTenant(t: any) {
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      plan: t.plan,
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
    dto: { username: string; email: string; password?: string },
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
        html: `<p>Hello ${dto.username},</p>
<p>A platform administrator has created an admin account for you on <strong>${tenant?.name ?? tenantId}</strong>.</p>
<p><strong>Username:</strong> ${dto.username}<br/>
<strong>Password:</strong> ${rawPassword}</p>
<p><em>Please log in and change your password immediately.</em></p>
<p>RouteFlow Platform</p>`,
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
}
