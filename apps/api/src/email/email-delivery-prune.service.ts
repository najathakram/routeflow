import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LeaderCron } from "../common/cron-lock";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Non-invoice delivery rows live 90 days; invoice-send rows (proof of delivery) 2 years. */
const RETENTION_DAYS = 90;
const INVOICE_RETENTION_DAYS = 730;
const BATCH = 5000;

@Injectable()
export class EmailDeliveryPruneService {
  private readonly logger = new Logger(EmailDeliveryPruneService.name);

  constructor(private readonly prisma: PrismaService) {}

  @LeaderCron("0 3 * * *", "email.pruneDeliveries")
  async runPrune(): Promise<void> {
    const out = await this.prune();
    if (out.deleted > 0) this.logger.log(`Pruned ${out.deleted} EmailDelivery rows`);
  }

  /** Cron loop: no ambient tenant, so every delete carries an explicit `tenantId`. */
  async prune(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const invoiceCutoff = new Date(now.getTime() - INVOICE_RETENTION_DAYS * DAY_MS);
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let deleted = 0;
    for (const { id: tenantId } of tenants) {
      try {
        const where = [
          {
            tenantId,
            // `not` alone would keep NULL-entity rows forever (SQL NULL <> 'Invoice' is unknown).
            OR: [
              { entityType: null, createdAt: { lt: cutoff } },
              { entityType: { not: "Invoice" }, createdAt: { lt: cutoff } },
            ],
          },
          { tenantId, entityType: "Invoice", createdAt: { lt: invoiceCutoff } },
        ];
        for (const w of where) deleted += await this.deleteAll(tenantId, w);
      } catch (err) {
        this.logger.warn(`EmailDelivery prune failed for a tenant: ${(err as Error)?.message}`);
      }
    }
    return { deleted };
  }

  /**
   * Truly bounded: select at most BATCH ids (`take`), delete exactly those (`id IN`), repeat
   * until the select comes back empty. Every statement carries the tenantId.
   */
  private async deleteAll(
    tenantId: string,
    where: Prisma.EmailDeliveryWhereInput,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.prisma.emailDelivery.findMany({
        where,
        select: { id: true },
        take: BATCH,
      });
      if (rows.length === 0) return total;
      const res = await this.prisma.emailDelivery.deleteMany({
        where: { tenantId, id: { in: rows.map((r) => r.id) } },
      });
      total += res.count;
    }
  }
}
