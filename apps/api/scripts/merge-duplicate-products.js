/**
 * One-off script: merge duplicate products (same name, same tenant) into a
 * single canonical row, reassigning all FK references before deleting dupes.
 *
 * Run from repo root:
 *   node apps/api/scripts/merge-duplicate-products.js            # dry run (lists groups)
 *   node apps/api/scripts/merge-duplicate-products.js --execute  # actually merge
 *
 * Safe to run multiple times — each run is idempotent.
 */

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const EXECUTE = process.argv.includes("--execute");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// All tables that have a productId FK pointing at Product.
const FK_TABLES = [
  { table: "OrderItem", col: "productId" },
  { table: "OrderTemplateItem", col: "productId" },
  { table: "InvoiceItem", col: "productId" },
  { table: "RecurringInvoiceItem", col: "productId" },
  { table: "EstimateItem", col: "productId" },
  { table: "PurchaseOrderItem", col: "productId" },
  { table: "VendorBillItem", col: "productId" },
  { table: "ReturnItem", col: "productId" },
  { table: "DeliveryMutation", col: "productId" },
  { table: "StockLot", col: "productId" },
  { table: "StockMovement", col: "productId" },
  { table: "CustomerPrice", col: "productId" },
  { table: "BuyerFavorite", col: "productId" },
  { table: "ExpenseLineItem", col: "productId" },
  { table: "ProductMapping", col: "productId" },
];

async function main() {
  // Find all (tenantId, lower(name)) groups that have more than one product.
  const dupeGroups = await prisma.$queryRaw`
    SELECT "tenantId", LOWER(name) AS lower_name, COUNT(*) AS cnt
    FROM "Product"
    GROUP BY "tenantId", LOWER(name)
    HAVING COUNT(*) > 1
    ORDER BY "tenantId", lower_name
  `;

  if (dupeGroups.length === 0) {
    console.log("✅  No duplicate products found — nothing to do.");
    return;
  }

  if (!EXECUTE) {
    console.log(`DRY RUN — found ${dupeGroups.length} duplicate group(s):`);
    for (const g of dupeGroups) {
      console.log(`  tenant ${g.tenantId}: "${g.lower_name}" ×${g.cnt}`);
    }
    console.log("\nRe-run with --execute to merge.");
    return;
  }

  console.log(`Found ${dupeGroups.length} duplicate group(s). Merging…\n`);

  let totalMerged = 0;

  for (const group of dupeGroups) {
    const { tenantId, lower_name } = group;

    // Fetch all products in this group, oldest first → keeper is index 0.
    const products = await prisma.product.findMany({
      where: { tenantId, name: { equals: lower_name, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, createdAt: true },
    });

    const [keeper, ...dupes] = products;
    const dupeIds = dupes.map((p) => p.id);

    console.log(
      `Tenant ${tenantId}: keeping "${keeper.name}" (${keeper.id}), ` +
        `merging ${dupeIds.length} duplicate(s): [${dupeIds.join(", ")}]`,
    );

    await prisma.$transaction(async (tx) => {
      // Reassign every FK table.
      for (const { table, col } of FK_TABLES) {
        const model = tx[table.charAt(0).toLowerCase() + table.slice(1)];
        if (!model) return; // safety guard for optional models

        // Some tables use nullable productId — update both nullable and required.
        await model.updateMany({
          where: { [col]: { in: dupeIds } },
          data: { [col]: keeper.id },
        });
      }

      // Reassign self-referential parentProductId (variants of duplicate → keeper).
      await tx.product.updateMany({
        where: { parentProductId: { in: dupeIds } },
        data: { parentProductId: keeper.id },
      });

      // Delete duplicates (variants of the dupe that still exist are cascaded
      // by the DB if ON DELETE CASCADE is set; otherwise delete them first).
      await tx.product.updateMany({
        where: { id: { in: dupeIds } },
        data: { parentProductId: null }, // detach any parent link to avoid self-ref constraint
      });

      await tx.product.deleteMany({
        where: { id: { in: dupeIds } },
      });
    });

    totalMerged += dupeIds.length;
    console.log(`  ✓ Merged.\n`);
  }

  console.log(
    `\n✅  Done. Merged ${totalMerged} duplicate product(s) across ${dupeGroups.length} group(s).`,
  );
}

main()
  .catch((e) => {
    console.error("❌  Error:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
