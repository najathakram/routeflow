import { Injectable, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { LeaderCron } from "../common/cron-lock";
import { overdueCutoff } from "../common/calendar-date";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

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
    await this.markOverdue();
  }

  async markOverdue(
    now: Date = new Date(),
  ): Promise<{ tenants: number; flipped: number; failed: number }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: [...SWEPT_TENANT_STATUSES] } },
      select: { id: true },
    });
    let flipped = 0;
    let failed = 0;
    for (const tenant of tenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        try {
          flipped += await markOverdueForTenant(this.prisma, tenant.id, now);
        } catch (err) {
          failed++;
          this.logger.error(
            `markOverdue failed for tenant ${tenant.id}: ${(err as Error)?.message}`,
          );
        }
      });
    }
    if (flipped > 0 || failed > 0)
      this.logger.log(
        `markOverdue: ${flipped} invoice(s) flipped across ${tenants.length} tenant(s), ${failed} failed`,
      );
    return { tenants: tenants.length, flipped, failed };
  }
}

/** One tenant's sweep: its own zone's day, an explicit tenant filter. Fails closed without a tenant. */
export async function markOverdueForTenant(
  prisma: Pick<PrismaService, "tenantConfig" | "invoice">,
  tenantId: string,
  now: Date,
): Promise<number> {
  if (!tenantId) throw new Error("markOverdue needs a tenant id (never an unscoped sweep)");
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const res = await prisma.invoice.updateMany({
    where: {
      tenantId,
      status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL] },
      dueDate: { lt: overdueCutoff(now, cfg?.timezone ?? null) },
    },
    data: { status: InvoiceStatus.OVERDUE },
  });
  return res.count;
}
