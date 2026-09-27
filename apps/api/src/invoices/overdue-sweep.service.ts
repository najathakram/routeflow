import { Injectable, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { LeaderCron } from "../common/cron-lock";
import { overdueCutoff } from "../common/calendar-date";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

/**
 * #2556 (owner policy, the lead's ruling): the sweep ships DARK. `OVERDUE_SWEEP_MODE`:
 *   off      (the default, and any unrecognised value) the cron writes nothing;
 *   dry-run  it only LOGS each tenant's would-flip count (anonymous: no slugs, no ids, no writes);
 *   on       it flips (the behaviour below).
 * Turning it on is an OWNER action, after the read-only count
 * (apps/api/scripts/report-2520-first-overdue-sweep.mjs): the first run flips the whole backlog.
 */
export type OverdueSweepMode = "off" | "dry-run" | "on";
export function overdueSweepMode(env: NodeJS.ProcessEnv = process.env): OverdueSweepMode {
  const v = String(env.OVERDUE_SWEEP_MODE ?? "")
    .trim()
    .toLowerCase();
  return v === "on" || v === "dry-run" ? v : "off";
}

/** The tenant statuses whose open invoices are aged (billing-live tenants only). */
const SWEPT_TENANT_STATUSES = ["TRIAL", "ACTIVE"] as const;

/**
 * #2520 (SA-495a): flip SENT / VIEWED / PARTIAL invoices to OVERDUE once their due day has ENDED in
 * THEIR tenant's zone (SA-488's `overdueCutoff`, UTC when the tenant has none).
 *
 * This used to be `InvoicesService.markOverdue()`: dead code, never scheduled, and a bare-cron
 * caller would have run it unscoped on the UTC day. It now runs HOURLY under `@LeaderCron` (one
 * replica), so every tenant flips within the hour after ITS local midnight. Each tenant is swept
 * with an explicit `tenantId` filter inside that tenant's context; one tenant failing never stops
 * the others. It shipped in the same PR as the required `timeZone` on every status writer, so the
 * persisted status never disagrees with the sweep.
 */
@Injectable()
export class OverdueSweepService {
  private readonly logger = new Logger(OverdueSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Hourly, one replica: every tenant flips within the hour after its own local midnight. */
  @LeaderCron("5 * * * *", "invoices.markOverdue")
  async runScheduled(): Promise<void> {
    const raw = process.env.OVERDUE_SWEEP_MODE;
    const mode = overdueSweepMode();
    if (mode === "off") {
      if (raw && raw.trim().toLowerCase() !== "off")
        this.logger.warn(`OVERDUE_SWEEP_MODE="${raw}" is not off|dry-run|on; treated as off`);
      return;
    }
    await this.markOverdue(new Date(), { dryRun: mode === "dry-run" });
  }

  async markOverdue(
    now: Date = new Date(),
    opts: { dryRun?: boolean } = {},
  ): Promise<{ tenants: number; flipped: number; failed: number }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: [...SWEPT_TENANT_STATUSES] } },
      select: { id: true },
    });
    let flipped = 0;
    let failed = 0;
    for (const [i, tenant] of tenants.entries()) {
      await this.tenantCtx.run(tenant.id, async () => {
        try {
          const n = await markOverdueForTenant(this.prisma, tenant.id, now, opts);
          flipped += n;
          // #2556: a dry run logs an ANONYMOUS per-tenant count only: no slug, no id, no write.
          if (opts.dryRun && n > 0)
            this.logger.log(`markOverdue DRY RUN: tenant #${i + 1} would flip ${n}`);
        } catch (err) {
          failed++;
          this.logger.error(`markOverdue failed for tenant #${i + 1}: ${(err as Error)?.message}`);
        }
      });
    }
    if (flipped > 0 || failed > 0)
      this.logger.log(
        `markOverdue${opts.dryRun ? " DRY RUN" : ""}: ${flipped} invoice(s) ${opts.dryRun ? "would flip" : "flipped"} across ${tenants.length} tenant(s), ${failed} failed`,
      );
    return { tenants: tenants.length, flipped, failed };
  }
}

/**
 * One tenant's sweep: its own zone's day, an explicit tenant filter. Fails closed without a
 * tenant. `dryRun` counts the rows it would flip and writes nothing.
 */
export async function markOverdueForTenant(
  prisma: Pick<PrismaService, "tenantConfig" | "invoice">,
  tenantId: string,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<number> {
  if (!tenantId) throw new Error("markOverdue needs a tenant id (never an unscoped sweep)");
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const where = {
    tenantId,
    status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL] },
    dueDate: { lt: overdueCutoff(now, cfg?.timezone ?? null) },
  };
  if (opts.dryRun) return prisma.invoice.count({ where });
  const res = await prisma.invoice.updateMany({ where, data: { status: InvoiceStatus.OVERDUE } });
  return res.count;
}
