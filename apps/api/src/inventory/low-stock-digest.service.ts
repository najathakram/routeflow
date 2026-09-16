import { Injectable, Logger } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";

/** Matches TenantConfig.timezone's own schema default — used only when a tenant somehow
 * has no config row (config is otherwise created alongside every tenant). */
const FALLBACK_TIMEZONE = "America/New_York";

/** The `UserPreference.key` a tenant admin's opt-out is stored under (N4). Missing row =
 * enabled, same convention as `notifications.service.ts`'s `pushEnabled` (B04). */
export const LOW_STOCK_DIGEST_PREF_KEY = "lowStockDigestEnabled";

interface LowStockItem {
  name: string;
  sku: string | null;
  currentStock: number;
  reorderPoint: number;
}

/** The tenant-local wall-clock date (YYYY-MM-DD) and hour (0-23) for `at`, in `timeZone`.
 * Unknown/invalid zone falls back to UTC rather than throwing — a cron tick must never
 * die on one tenant's bad timezone string. */
function readLocalDateAndHour(at: Date, timeZone: string): { dateKey: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
  } catch {
    return {
      dateKey: at.toISOString().slice(0, 10),
      hour: at.getUTCHours(),
    };
  }
}

/** `TenantConfig.lowStockDigestSentForDay` is a `@db.Date` column — Prisma returns it as a
 * UTC-midnight `Date`. Compare it to a `dateKey` the same way `calendarDateFromIso` reads one. */
function sentForDayKey(sentForDay: Date | null): string | null {
  if (!sentForDay) return null;
  return sentForDay.toISOString().slice(0, 10);
}

/**
 * N4 — daily low-stock digest to tenant admins. The realtime `inventory.low.stock` socket
 * event (`routeflow.gateway.ts#emitLowStock`) is UNCHANGED and unrelated to this — this is a
 * separate, once-a-day SUMMARY email, deliberately not routed through MessagingService (that
 * engine is customer/thread-shaped — `SendMessageInput.customerId` is required — and has no
 * concept of an internal tenant-admin recipient; NotificationEvent.LOW_STOCK stays wired to
 * nothing, per `messaging/default-on-is-wired.spec.ts`'s negative control).
 *
 * Ticks hourly (LeaderCron, cross-replica-safe) and for each tenant checks whether the
 * tenant's OWN local wall-clock is currently in the 07:00 hour — this is what makes a single
 * server-wide hourly sweep deliver at "07:00 tenant-local" for every timezone (including
 * half/quarter-hour UTC offsets: whatever minute within the local 07:xx hour the UTC tick
 * lands on, `hour === 7` is still true for exactly one tick per day). Idempotent per
 * (tenant, local day) via `TenantConfig.lowStockDigestSentForDay` — same convention as the
 * check-payments PR-1 scaffolded (but unused) `checksDigestSentForDay` column — written
 * whether or not an email was actually sent, so a restart or a repeated local hour-7 (DST
 * "fall back" in a zone with a duplicated wall-clock hour) can never double-process the day.
 */
@Injectable()
export class LowStockDigestService {
  private readonly logger = new Logger(LowStockDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  @LeaderCron(CronExpression.EVERY_HOUR, "inventory.sendLowStockDigest")
  async sendLowStockDigest(now: Date = new Date()): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null, status: { notIn: ["SUSPENDED", "CANCELLED"] } },
      select: {
        id: true,
        config: {
          select: { timezone: true, businessName: true, lowStockDigestSentForDay: true },
        },
      },
    });

    for (const t of tenants) {
      // Fail closed per tenant: one tenant's bad data/timezone/send must never stop the
      // sweep for every other tenant, and must never throw out of the cron tick.
      try {
        await this.processTenant(t.id, t.config, now);
      } catch (err) {
        this.logger.error(
          `low-stock digest failed for tenant ${t.id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  private async processTenant(
    tenantId: string,
    config: {
      timezone: string;
      businessName: string | null;
      lowStockDigestSentForDay: Date | null;
    } | null,
    now: Date,
  ): Promise<void> {
    const timeZone = config?.timezone || FALLBACK_TIMEZONE;
    const { dateKey, hour } = readLocalDateAndHour(now, timeZone);
    if (hour !== 7) return;
    if (sentForDayKey(config?.lowStockDigestSentForDay ?? null) === dateKey) return;

    const items = await this.getLowStockItems(tenantId);
    if (items.length > 0) {
      const recipients = await this.getDigestRecipients(tenantId);
      const businessName = config?.businessName || "RouteFlow";
      for (const r of recipients) {
        // Fail closed per recipient too — EmailService.send() already never throws, but a
        // template-build error must not stop the remaining recipients or the day-mark below.
        try {
          const result = await this.email.sendLowStockDigest({
            to: r.email,
            businessName,
            items,
          });
          if (!result.delivered) {
            this.logger.warn(
              `low-stock digest not delivered to ${r.email} (tenant ${tenantId}): ${result.error ?? result.transport}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `low-stock digest send threw for ${r.email} (tenant ${tenantId}): ${(err as Error)?.message ?? err}`,
          );
        }
      }
    }

    // Marks the day processed whether or not there was anything to send / anyone to send it
    // to — a zero-item or zero-recipient day is still "handled" and must not re-fire later
    // the same local day. `updateMany` (not `update`) tolerates a tenant with no TenantConfig
    // row (rare — config is normally created alongside the tenant): it simply matches zero
    // rows instead of throwing, which degrades to "recheck this tenant every hour-7 tick"
    // rather than crashing the sweep.
    await this.prisma.tenantConfig.updateMany({
      where: { tenantId },
      data: { lowStockDigestSentForDay: new Date(`${dateKey}T00:00:00.000Z`) },
    });
  }

  /** Same predicate as `inventory.service.ts#getForecasting`'s `needsReorder` — one rule for
   * "below threshold", never re-derived. `reorderPoint` unset (null) means the tenant never
   * opted this product into alerting at all, not "always alert". */
  private async getLowStockItems(tenantId: string): Promise<LowStockItem[]> {
    const products = await this.prisma.product.findMany({
      where: { tenantId, isActive: true, reorderPoint: { not: null } },
      select: { name: true, sku: true, currentStock: true, reorderPoint: true },
    });
    return products
      .filter((p) => p.reorderPoint != null && Number(p.currentStock) < p.reorderPoint)
      .map((p) => ({
        name: p.name,
        sku: p.sku,
        currentStock: Number(p.currentStock),
        reorderPoint: p.reorderPoint as number,
      }));
  }

  /** Active TENANT_ADMINs with an email on file, minus anyone who has explicitly opted out
   * via `UserPreference{key: LOW_STOCK_DIGEST_PREF_KEY, value: "false"}` — B04's per-user
   * opt-out convention, not a new mechanism. Exposed via the existing generic
   * `GET/PATCH /users/me/preferences` endpoints (users.controller.ts) — N4 adds no new API. */
  private async getDigestRecipients(tenantId: string): Promise<{ email: string }[]> {
    const admins = await this.prisma.user.findMany({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      select: { id: true, email: true },
    });
    const withEmail = admins.filter((a) => a.email);
    if (!withEmail.length) return [];

    const optOuts = await this.prisma.userPreference.findMany({
      where: {
        userId: { in: withEmail.map((a) => a.id) },
        key: LOW_STOCK_DIGEST_PREF_KEY,
        value: "false",
      },
      select: { userId: true },
    });
    const optedOut = new Set(optOuts.map((o) => o.userId));
    return withEmail.filter((a) => !optedOut.has(a.id)).map((a) => ({ email: a.email }));
  }
}
