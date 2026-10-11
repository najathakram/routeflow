import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";

/** Expired link rows are kept this long (a replayed link keeps resolving to "used or expired"). */
export const LINK_TOKEN_RETENTION_DAYS = 7;

/** Rows deleted per statement; the loop ends on a short batch. */
export const LINK_TOKEN_SWEEP_BATCH = 500;

/** The four single-use link tables: staff and buyer, email verification and password reset. */
export const LINK_TOKEN_MODELS = [
  "userEmailVerificationToken",
  "passwordResetToken",
  "buyerEmailVerificationToken",
  "buyerPasswordResetToken",
] as const;
export type LinkTokenModel = (typeof LINK_TOKEN_MODELS)[number];

/**
 * Daily cleanup of expired account links, one replica (`@LeaderCron`). It spans every tenant, so
 * it runs on the base (UNSCOPED) PrismaService: there is no ambient tenant in a cron tick, and
 * these tables carry no tenant column. The only input is the clock. For each of the four models it
 * selects ids of rows that expired more than `LINK_TOKEN_RETENTION_DAYS` ago, in bounded batches,
 * and deletes exactly those ids (re-applying the predicate, so a row that changed in between is
 * never deleted). Used-but-unexpired rows stay until they expire. It logs counts only.
 */
@Injectable()
export class LinkTokenSweepService {
  private readonly logger = new Logger(LinkTokenSweepService.name);

  constructor(private readonly prisma: PrismaService) {}

  @LeaderCron("40 3 * * *", "auth.linkTokenSweep")
  async runScheduled(): Promise<void> {
    const deleted = await this.sweep();
    const total = Object.values(deleted).reduce((n, c) => n + c, 0);
    if (total > 0) this.logger.log(`auth.linkTokenSweep: deleted ${total} expired link rows`);
  }

  async sweep(now: Date = new Date()): Promise<Record<LinkTokenModel, number>> {
    const cutoff = new Date(now.getTime() - LINK_TOKEN_RETENTION_DAYS * 86_400_000);
    const stale = { expiresAt: { lt: cutoff } };
    const deleted = {} as Record<LinkTokenModel, number>;
    for (const model of LINK_TOKEN_MODELS) {
      const table = this.prisma[model] as unknown as {
        findMany(args: unknown): Promise<Array<{ id: string }>>;
        deleteMany(args: unknown): Promise<{ count: number }>;
      };
      let count = 0;
      for (;;) {
        const rows = await table.findMany({
          where: stale,
          select: { id: true },
          orderBy: { id: "asc" },
          take: LINK_TOKEN_SWEEP_BATCH,
        });
        if (rows.length === 0) break;
        const res = await table.deleteMany({
          where: { AND: [stale, { id: { in: rows.map((r) => r.id) } }] },
        });
        count += res.count;
        // A short batch is the last; a batch that deleted nothing would only be selected again.
        if (rows.length < LINK_TOKEN_SWEEP_BATCH || res.count === 0) break;
      }
      deleted[model] = count;
    }
    return deleted;
  }
}
