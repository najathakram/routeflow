import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { TenantStatus, TenantPlan } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AppConfig } from "../config/configuration";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { IRS_SYSTEM_CATEGORIES } from "../bookkeeping/irs-categories.constant";
import { ActivateSubscriptionDto } from "./dto/activate-subscription.dto";
import { UpdateTenantConfigDto } from "./dto/update-tenant-config.dto";
import { AuditService } from "../audit/audit.service";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY,
  ADMIN_AUDIT_ACTION_FACETS,
  adminAuditActionLabel,
  type AdminAuditActionCode,
} from "./audit-actions.constant";
import { STOPGAP_PLAN_MONTHLY_USD, estimatePlatformMrrUsd } from "./plan-pricing.constant";

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig>,
    private readonly emailService: EmailService,
    private readonly billingService: BillingService,
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

    const [tenants, total] = await Promise.all([
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
    ]);

    return {
      data: tenants.map((t) => this._formatTenant(t)),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async getTenant(id: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [tenant, orders30d] = await Promise.all([
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
    ]);
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return {
      ...this._formatTenant(tenant),
      orders30d,
      estMrrUsd: STOPGAP_PLAN_MONTHLY_USD[tenant.plan] ?? 0,
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
          canActAsDriver: true, // admins can act as driver by default
        },
      });

      // Auto-create a driver profile so the admin can use driver features immediately
      await tx.driver.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          contactName: adminUsername,
          phone: "",
          status: "ACTIVE",
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
    return { id: tenant.id, slug: tenant.slug, status: tenant.status };
  }

  async updatePlan(id: string, dto: UpdateTenantPlanDto, adminId: string | null = null) {
    const before = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, plan: true },
    });
    if (!before) throw new NotFoundException(`Tenant ${id} not found`);
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: { plan: dto.plan },
    });
    // Upsert subscription record to reflect plan change
    await this.prisma.tenantSubscription.upsert({
      where: { tenantId: id },
      create: { tenantId: id, currentPlan: dto.plan },
      update: { currentPlan: dto.plan },
    });
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
          cancelAtPeriodEnd: false,
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
      planBreakdown,
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
      this.prisma.tenant.groupBy({
        by: ["plan"],
        _count: { plan: true },
      }),
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

    const planCounts = Object.fromEntries(
      planBreakdown.map(({ plan, _count }) => [plan, _count.plan]),
    );

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
      // Display-only stopgap MRR (see plan-pricing.constant.ts) until the
      // billing-plans catalog owns the real rollup.
      estMrrUsd: estimatePlatformMrrUsd(planCounts),
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

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async _findOrThrow(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return tenant;
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
        canActAsDriver: true, // admins can act as driver by default
      },
      select: { id: true, username: true, email: true, status: true, createdAt: true },
    });

    // Auto-create a driver profile so the admin can use driver features immediately
    await this.prisma.driver
      .create({
        data: {
          userId: user.id,
          tenantId,
          contactName: dto.username,
          phone: "",
          status: "ACTIVE",
        },
      })
      .catch(() => {
        /* ignore if driver record already exists */
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
