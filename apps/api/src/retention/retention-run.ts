import type { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** SA-1083 G6: ids selected per statement, and rows one run may delete. The first runs can take several nights. */
export const RETENTION_BATCH = 5000;
export const RETENTION_MAX_ROWS_PER_RUN = 200_000;

/**
 * One audit row per run: cutoff and counts, no personal data. No tenant on the row, because a run spans tenants. A failed
 * write is logged and never fails the job: the rows it counted are already settled.
 */
export async function recordRetentionRun(
  prisma: PrismaService,
  logger: Logger,
  action: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { action, entityType: "RetentionRun", meta } });
  } catch (err) {
    logger.error(`Failed to write the ${action} audit row`, err as Error);
  }
}
