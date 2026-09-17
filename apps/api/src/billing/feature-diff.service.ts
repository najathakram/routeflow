import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { FeatureSource } from "@routeflow/types";

/**
 * Design 2026-09-17 §2 "Effective": shadow-mode disagreement between the old enforcement path
 * and the resolver, one row per (tenantId, featureKey, before, after) — a recurrence upserts
 * count/lastSeenAt rather than inserting again (the partial-pair uniqueness lives in the
 * migration's unique index, not here). Fails open (logs, never throws) — a diff-log write
 * failure must never turn into a request-path 500 for the caller that triggered it.
 */
@Injectable()
export class FeatureDiffService {
  private readonly logger = new Logger(FeatureDiffService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Record one (before, after) disagreement for (tenantId, featureKey). Never throws. */
  async record(
    tenantId: string,
    featureKey: string,
    before: boolean,
    after: boolean,
    source: FeatureSource,
  ): Promise<void> {
    try {
      const existing = await this.prisma.featureResolverDiff.findUnique({
        where: {
          tenantId_featureKey_before_after: { tenantId, featureKey, before, after },
        },
      });
      if (existing) {
        await this.prisma.featureResolverDiff.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date(), count: { increment: 1 }, source },
        });
      } else {
        await this.prisma.featureResolverDiff.create({
          data: { tenantId, featureKey, before, after, source },
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed to record diff for tenant ${tenantId} key ${featureKey}`,
        err as Error,
      );
    }
  }

  async list(params: { tenantId?: string; unexplainedOnly?: boolean }) {
    return this.prisma.featureResolverDiff.findMany({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.unexplainedOnly ? { explainedAt: null } : {}),
      },
      orderBy: { lastSeenAt: "desc" },
    });
  }

  async hasUnexplained(): Promise<boolean> {
    const count = await this.prisma.featureResolverDiff.count({ where: { explainedAt: null } });
    return count > 0;
  }

  async explain(id: string, explanation: string) {
    try {
      return await this.prisma.featureResolverDiff.update({
        where: { id },
        data: { explainedAt: new Date(), explanation },
      });
    } catch {
      throw new NotFoundException(`No diff row "${id}" found.`);
    }
  }
}
