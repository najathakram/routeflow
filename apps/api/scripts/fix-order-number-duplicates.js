/**
 * RF-014 — One-shot idempotent dedup for known duplicate orderNumber collisions.
 *
 * Usage (from repo root):
 *   DATABASE_URL="<railway-url>" node apps/api/scripts/fix-order-number-duplicates.js
 *
 * What it does:
 *   1. Finds every (tenantId, orderNumber) pair that appears more than once.
 *   2. Keeps the OLDEST order (lowest createdAt) unchanged.
 *   3. Appends "-DUP-<suffix>" to all later duplicates so the unique index
 *      can be applied without conflicts.
 *   4. Idempotent: rows already renamed "-DUP-*" are skipped.
 *
 * DO NOT run on prod without a backup.
 */

const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();

  try {
    // Find all (tenantId, orderNumber) groups with more than one row,
    // excluding already-renamed duplicates.
    const dupes = await prisma.$queryRaw`
      SELECT "tenantId", "orderNumber", COUNT(*) AS cnt
      FROM "Order"
      WHERE "orderNumber" IS NOT NULL
        AND "orderNumber" NOT LIKE '%-DUP-%'
      GROUP BY "tenantId", "orderNumber"
      HAVING COUNT(*) > 1
    `;

    if (dupes.length === 0) {
      console.log("No duplicate orderNumbers found — nothing to do.");
      return;
    }

    console.log(`Found ${dupes.length} duplicate group(s). Renaming extras...`);

    for (const { tenantId, orderNumber, cnt } of dupes) {
      // Fetch all orders in this group, oldest first (oldest = canonical winner)
      const orders = await prisma.order.findMany({
        where: { tenantId, orderNumber },
        orderBy: { createdAt: "asc" },
        select: { id: true, orderNumber: true, createdAt: true },
      });

      // Skip the first (oldest) — rename the rest
      const losers = orders.slice(1);
      for (let i = 0; i < losers.length; i++) {
        const loser = losers[i];
        const newNumber = `${orderNumber}-DUP-${i + 1}`;
        await prisma.order.update({
          where: { id: loser.id },
          data: { orderNumber: newNumber },
        });
        console.log(`  Renamed order ${loser.id}: ${orderNumber} → ${newNumber}`);
      }
    }

    console.log("Done. You can now safely apply the unique index migration.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
