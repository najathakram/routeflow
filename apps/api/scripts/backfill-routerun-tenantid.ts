/**
 * RF-001 backfill: set tenantId on RouteRun rows that currently have tenantId=null.
 *
 * Derives the correct tenantId by joining through route → tenantId.
 * Safe to run multiple times (no-op on rows that already have tenantId set).
 *
 * Usage (from repo root):
 *   cd apps/api && npx ts-node -r tsconfig-paths/register scripts/backfill-routerun-tenantid.ts
 */

import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();

  try {
    // Find all RouteRun rows with null tenantId that have a related Route with a tenantId.
    const nullRuns = await prisma.routeRun.findMany({
      where: { tenantId: null },
      select: { id: true, routeId: true },
    });

    if (nullRuns.length === 0) {
      console.log("No RouteRun rows with tenantId=null — nothing to do.");
      return;
    }

    console.log(`Found ${nullRuns.length} RouteRun row(s) with tenantId=null. Backfilling…`);

    const routeIds = [...new Set(nullRuns.map((r) => r.routeId))];
    const routes = await prisma.route.findMany({
      where: { id: { in: routeIds } },
      select: { id: true, tenantId: true },
    });
    const routeTenantMap = new Map(routes.map((r) => [r.id, r.tenantId]));

    let updated = 0;
    let skipped = 0;

    for (const run of nullRuns) {
      const tenantId = routeTenantMap.get(run.routeId);
      if (!tenantId) {
        console.warn(`  SKIP ${run.id}: parent route ${run.routeId} also has tenantId=null`);
        skipped++;
        continue;
      }
      await prisma.routeRun.update({ where: { id: run.id }, data: { tenantId } });
      updated++;
    }

    console.log(`Done. Updated: ${updated}, Skipped (no parent tenant): ${skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
