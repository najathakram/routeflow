import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { AuditService } from "../audit/audit.service";

type WarnBucket = 30 | 7 | 1;

interface OperatorRecipient {
  id: string;
  email: string | null;
}

/**
 * Phase 4 (W7): the license-expiry sweep. A daily cron flips VERIFIED
 * authorizations past their expiresAt to EXPIRED (making the persisted status
 * truthful — the W6 guard already lazy-blocks them) and notifies both the seller
 * and the buyer, plus 30/7/1-day expiring-soon warnings. Mirrors the tobacco-report
 * cron: enumerate active tenants (that actually run a license-required program),
 * run each inside tenantCtx so all writes are tenant-scoped, per-tenant try/catch.
 *
 * Idempotency: there is no in-app notification store, so each notice is deduped by
 * two markers on the row — `expiryNotifiedAt` (the EXPIRED flip fires once) and
 * `expiringSoonNotifiedBucket` (a warning fires once per 30/7/1 bucket, only as the
 * bucket shrinks). renew()/create()/approve() reset both so a re-verified row that
 * later re-expires notifies again.
 */
@Injectable()
export class AuthorizationExpiryService {
  private readonly logger = new Logger(AuthorizationExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  /** Days-until-expiry warning bucket (30/7/1), or null if not in one. */
  bucketFor(expiresAt: Date, now: Date): WarnBucket | null {
    const ms = expiresAt.getTime() - now.getTime();
    if (ms <= 0) return null; // already expired — the flip path handles it
    const days = Math.ceil(ms / 86_400_000);
    if (days <= 1) return 1;
    if (days <= 7) return 7;
    if (days <= 30) return 30;
    return null;
  }

  @Cron("0 3 * * *") // 03:00 UTC daily (offset from tobacco's 02:00)
  async runExpirySweep(): Promise<void> {
    const [activeTenants, gatedRows] = await Promise.all([
      this.prisma.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
      this.prisma.trackedCategory.findMany({
        where: { requiresLicense: true },
        select: { tenantId: true },
      }),
    ]);
    const gated = new Set(gatedRows.map((t) => t.tenantId));
    const tenants = activeTenants.filter((t) => gated.has(t.id));
    if (tenants.length === 0) return;

    let expired = 0;
    let warned = 0;
    let failed = 0;
    for (const tenant of tenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        try {
          const r = await this.processTenant(tenant.id);
          expired += r.expired;
          warned += r.warned;
        } catch (err) {
          failed++;
          this.logger.error(
            `[tenant:${tenant.id}] expiry sweep failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      });
    }
    this.logger.log(
      `Authorization expiry sweep: ${expired} expired, ${warned} warned, ${failed} failed across ${tenants.length} tenant(s).`,
    );
  }

  /** Testable per-tenant core — MUST run inside tenantCtx.run (tenant-scoped writes). */
  async processTenant(
    tenantId: string,
    now = new Date(),
  ): Promise<{ expired: number; warned: number }> {
    const operators = await this.loadOperators(tenantId);

    // 1. Flip VERIFIED → EXPIRED (past expiresAt) + notify once.
    const toExpire = await this.prisma.forTenant().customerAuthorization.findMany({
      where: { status: "VERIFIED", expiresAt: { lt: now } },
      include: { trackedCategory: { select: { name: true, requiresLicense: true } } },
    });
    let expired = 0;
    for (const auth of toExpire) {
      if (!auth.trackedCategory?.requiresLicense) continue; // non-gated (tobacco) — never notify/flip-spam
      try {
        await this.prisma.forTenant().customerAuthorization.update({
          where: { id: auth.id },
          data: { status: "EXPIRED", expiryNotifiedAt: now },
        });
        await this.audit.log({
          tenantId,
          userId: null,
          action: "regulated_authorization.expired",
          entityType: "CustomerAuthorization",
          entityId: auth.id,
          meta: { customerId: auth.customerId, trackedCategoryId: auth.trackedCategoryId },
        });
        await this.notify(
          auth,
          operators,
          `License expired: ${auth.trackedCategory.name}`,
          `has EXPIRED. Regulated sales in this category are blocked until it is renewed.`,
        );
        expired++;
      } catch (err) {
        // Per-row isolation — a single bad row must not skip the rest of the sweep.
        this.logger.error(
          `[tenant:${tenantId}] expire ${auth.id} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 2. Warn EXPIRING-SOON (30/7/1) — no status change, once per bucket.
    const soon = await this.prisma.forTenant().customerAuthorization.findMany({
      where: {
        status: "VERIFIED",
        expiresAt: { gte: now, lt: new Date(now.getTime() + 31 * 86_400_000) },
      },
      include: { trackedCategory: { select: { name: true, requiresLicense: true } } },
    });
    let warned = 0;
    for (const auth of soon) {
      if (!auth.trackedCategory?.requiresLicense || !auth.expiresAt) continue;
      const bucket = this.bucketFor(new Date(auth.expiresAt), now);
      if (bucket === null) continue;
      // Fire only when this bucket hasn't been sent (buckets only shrink toward expiry).
      const last = auth.expiringSoonNotifiedBucket;
      if (last !== null && last <= bucket) continue;
      try {
        await this.prisma.forTenant().customerAuthorization.update({
          where: { id: auth.id },
          data: { expiringSoonNotifiedBucket: bucket },
        });
        await this.notify(
          auth,
          operators,
          `License expiring in ${bucket} day(s): ${auth.trackedCategory.name}`,
          `expires in ${bucket} day(s). Renew it to avoid a block on regulated sales.`,
        );
        warned++;
      } catch (err) {
        this.logger.error(
          `[tenant:${tenantId}] warn ${auth.id} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return { expired, warned };
  }

  private async loadOperators(tenantId: string): Promise<OperatorRecipient[]> {
    return this.prisma.user.findMany({
      where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
      select: { id: true, email: true },
    });
  }

  /** Notify the buyer (push) + the seller's operators (push + email). Best-effort. */
  private async notify(
    auth: { customerId: string },
    operators: OperatorRecipient[],
    subject: string,
    detail: string,
  ): Promise<void> {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: auth.customerId }, select: { businessName: true } });
    const who = customer?.businessName ?? "A customer";
    const body = `Your license ${detail}`;

    await this.notifications.sendToCustomer(auth.customerId, subject, body).catch(() => {});

    const opBody = `${who}'s license ${detail}`;
    for (const op of operators) {
      await this.notifications.sendToUser(op.id, { title: subject, body: opBody }).catch(() => {});
      if (op.email && !op.email.startsWith("no-email+")) {
        await this.email
          .send({ to: op.email, subject: `${who} — ${subject}`, html: `<p>${opBody}</p>` })
          .catch(() => {});
      }
    }
  }
}
