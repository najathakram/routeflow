import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { COUNTER_PARK_SWEEP_RESUMED_HOURS } from "@routeflow/pricing";
import { LeaderCron } from "../../common/cron-lock";
import { PrismaService } from "../../prisma/prisma.service";
import { COUNTER_PARK_SWEEP_BATCH } from "./counter-park";

/**
 * Hourly cleanup of `CounterParkedCart` (SA-748), one replica (`@LeaderCron`, never a bare `@Cron`): deletes a row that
 * was RESUMED more than COUNTER_PARK_SWEEP_RESUMED_HOURS ago (its same-actor retry window is long past) or whose
 * `expiresAt` has passed. It spans every tenant, so it runs on the base (UNSCOPED) PrismaService: there is no ambient
 * tenant in a cron tick. The only input is the clock; it selects ids in bounded batches, deletes exactly those ids
 * (re-applying the same predicate, so a row that changed state in between is never deleted), and loops until a batch
 * comes back short. It logs counts only: no id, tenant or payload.
 */
@Injectable()
export class CounterParkSweepService {
  private readonly logger = new Logger(CounterParkSweepService.name);

  constructor(private readonly prisma: PrismaService) {}

  @LeaderCron("20 * * * *", "counter.parkSweep")
  async runScheduled(): Promise<void> {
    const { deleted } = await this.sweep();
    if (deleted > 0) this.logger.log(`counter.parkSweep: deleted ${deleted} parked-cart rows`);
  }

  async sweep(now: Date = new Date()): Promise<{ deleted: number }> {
    const resumedBefore = new Date(now.getTime() - COUNTER_PARK_SWEEP_RESUMED_HOURS * 3_600_000);
    const stale: Prisma.CounterParkedCartWhereInput = {
      OR: [{ resumedAt: { lt: resumedBefore } }, { expiresAt: { lt: now } }],
    };
    let deleted = 0;
    for (;;) {
      const rows = await this.prisma.counterParkedCart.findMany({
        where: stale,
        select: { id: true },
        orderBy: { id: "asc" },
        take: COUNTER_PARK_SWEEP_BATCH,
      });
      if (rows.length === 0) break;
      const res = await this.prisma.counterParkedCart.deleteMany({
        where: { AND: [stale, { id: { in: rows.map((r) => r.id) } }] },
      });
      deleted += res.count;
      // A short batch is the last one; a batch that deleted nothing would only be selected again, so stop.
      if (rows.length < COUNTER_PARK_SWEEP_BATCH || res.count === 0) break;
    }
    return { deleted };
  }
}
