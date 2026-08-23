import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "./commission-engine.service";

/**
 * Hourly self-healing sweep for the commission ledger. Hooks call
 * `syncInvoiceCommissionSafe`, which swallows its own errors so a commission
 * bug can never block an invoice or payment write — this cron is what heals
 * whatever those hooks swallowed (and anything a crash left half-synced).
 *
 * Fires at minute 30 because the other hourly jobs fire at :00. The 25h
 * lookback deliberately overlaps the 1h cadence: `syncInvoiceCommission` is
 * idempotent, so re-syncing unchanged invoices writes nothing.
 */
@Injectable()
export class CommissionReconciliationService {
  private readonly logger = new Logger(CommissionReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly entitlements: EntitlementsService,
    private readonly commissionEngine: CommissionEngineService,
  ) {}

  @Cron("30 * * * *")
  async reconcileCommissions() {
    // Cron has no HTTP request context so ALS is empty. Fetch all active
    // tenants and run each in its own ALS scope so forTenant() works.
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    let totalSynced = 0;

    for (const tenant of activeTenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        if (!(await this.entitlements.hasFlag(tenant.id, "flag.sales_agents"))) return;

        const invoices = await this.prisma.forTenant().invoice.findMany({
          where: {
            status: { not: "DRAFT" },
            updatedAt: { gte: new Date(Date.now() - 25 * 3600_000) },
          },
          select: { id: true },
        });

        if (invoices.length === 0) return;
        this.logger.log(
          `[tenant:${tenant.id}] Reconciling commissions for ${invoices.length} invoice(s)…`,
        );

        for (const invoice of invoices) {
          await this.commissionEngine.syncInvoiceCommissionSafe(invoice.id);
          totalSynced++;
        }
      });
    }

    if (totalSynced > 0) {
      this.logger.log(
        `Commission reconciliation: ${totalSynced} invoice(s) re-synced across ${activeTenants.length} tenant(s).`,
      );
    }
  }
}
