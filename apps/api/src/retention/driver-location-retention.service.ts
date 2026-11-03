import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { RETENTION_BATCH, RETENTION_MAX_ROWS_PER_RUN, recordRetentionRun } from "./retention-run";
import {
  RETENTION_LOCATION_SWITCH,
  RetentionMode,
  RetentionSwitchService,
} from "./retention-switch.service";

export const LOCATION_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export type TenantLocationCount = {
  due: number;
  deleted: number;
  held: boolean;
};

export interface LocationRetentionResult {
  mode: RetentionMode;
  cutoff: Date;
  /** Points past the cutoff on tenants with no hold. */
  due: number;
  deleted: number;
  heldRows: number;
  /** Counted and kept: they can't be held by tenant, so SA-1083 decides them from the census. */
  noTenantRows: number;
  failedTenants: number;
  capped: boolean;
  perTenant: Record<string, TenantLocationCount>;
}

/** The phone supplies `recordedAt`, so the older of the two dates decides (SA-1083 RT-5). */
function dueWhere(tenantId: string | null, cutoff: Date): Prisma.DriverLocationWhereInput {
  return { tenantId, OR: [{ recordedAt: { lt: cutoff } }, { createdAt: { lt: cutoff } }] };
}

/**
 * SA-1083: stored driver points past 90 days, on every tenant. Report-only until its switch is on: the same plan runs
 * and only the counts are written.
 */
@Injectable()
export class DriverLocationRetentionService {
  private readonly logger = new Logger(DriverLocationRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly switches: RetentionSwitchService,
  ) {}

  @LeaderCron("15 3 * * *", "retention.driverLocations")
  async runCron(): Promise<void> {
    await this.run();
  }

  async run(now: Date = new Date()): Promise<LocationRetentionResult> {
    const mode = await this.switches.modeOf(RETENTION_LOCATION_SWITCH);
    const cutoff = new Date(now.getTime() - LOCATION_RETENTION_DAYS * DAY_MS);
    const out: LocationRetentionResult = {
      mode,
      cutoff,
      due: 0,
      deleted: 0,
      heldRows: 0,
      noTenantRows: 0,
      failedTenants: 0,
      capped: false,
      perTenant: {},
    };

    const tenants = await this.prisma.tenant.findMany({
      select: { id: true, retentionHoldAt: true },
    });
    let budget = RETENTION_MAX_ROWS_PER_RUN;
    for (const tenant of tenants) {
      try {
        const drivers = await this.prisma.driverLocation.groupBy({
          by: ["driverId"],
          where: dueWhere(tenant.id, cutoff),
          _count: { _all: true },
        });
        const due = drivers.reduce((sum, d) => sum + d._count._all, 0);
        if (due === 0) continue;
        const counts: TenantLocationCount = {
          due,
          deleted: 0,
          held: tenant.retentionHoldAt != null,
        };
        out.perTenant[tenant.id] = counts;
        if (counts.held) {
          out.heldRows += due;
          continue;
        }
        out.due += due;
        if (mode !== "enforce") continue;
        for (const { driverId } of drivers) {
          const deleted = await this.deleteDriverPoints(
            tenant.id,
            driverId,
            cutoff,
            budget,
            (n) => {
              counts.deleted += n;
              out.deleted += n;
            },
          );
          budget -= deleted;
        }
      } catch (err) {
        out.failedTenants += 1;
        this.logger.warn(
          `Location retention failed for tenant ${tenant.id}: ${(err as Error)?.message}`,
        );
      }
    }
    out.capped = budget <= 0;

    try {
      out.noTenantRows = await this.prisma.driverLocation.count({ where: dueWhere(null, cutoff) });
    } catch (err) {
      this.logger.warn(
        `Location retention could not count no-tenant rows: ${(err as Error)?.message}`,
      );
    }

    await recordRetentionRun(
      this.prisma,
      this.logger,
      AUDIT_ACTIONS.RETENTION_DRIVER_LOCATIONS_RUN,
      {
        mode,
        cutoff: cutoff.toISOString(),
        due: out.due,
        deleted: out.deleted,
        heldRows: out.heldRows,
        noTenantRows: out.noTenantRows,
        failedTenants: out.failedTenants,
        capped: out.capped,
        perTenant: { ...out.perTenant },
      },
    );
    this.logger.log(
      `Location retention (${mode}): ${out.due} due, ${out.deleted} deleted, ${out.heldRows} held, ${out.noTenantRows} no tenant`,
    );
    return out;
  }

  /**
   * Select at most a batch of ids, delete exactly those, repeat. Each delete re-reads the hold, so a hold set mid-run
   * deletes nothing more, and a delete that removes nothing ends the loop instead of selecting the same ids again.
   */
  private async deleteDriverPoints(
    tenantId: string,
    driverId: string,
    cutoff: Date,
    budget: number,
    onDeleted: (n: number) => void,
  ): Promise<number> {
    let total = 0;
    while (total < budget) {
      const rows = await this.prisma.driverLocation.findMany({
        where: { ...dueWhere(tenantId, cutoff), driverId },
        select: { id: true },
        take: Math.min(RETENTION_BATCH, budget - total),
      });
      if (rows.length === 0) return total;
      const { count } = await this.prisma.driverLocation.deleteMany({
        where: {
          tenantId,
          driverId,
          id: { in: rows.map((r) => r.id) },
          tenant: { retentionHoldAt: null },
        },
      });
      if (count === 0) return total;
      total += count;
      onDeleted(count);
    }
    return total;
  }
}
