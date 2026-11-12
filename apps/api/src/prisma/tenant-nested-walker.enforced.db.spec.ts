/**
 * SA-1110 (B929) row W-0 on a real Postgres (the DB lane): with `TENANT_CONTEXT_ENFORCEMENT=on`, a TENANT-context create
 * of a VendorBill whose nested item names no tenant must go through, because the walker stamps the item before the
 * guard looks. On master the guard throws TENANT_CONTEXT_MISSING at the nested gap. The flag is read once when the
 * guard module loads, so it is set before the service is required and this row lives in its own file (own module
 * registry); the other rows need the dark guard to observe the stored value.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { TenantContextService } from "../tenant/tenant-context.service";

process.env.TENANT_CONTEXT_ENFORCEMENT = "on";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaService } = require("./prisma.service") as typeof import("./prisma.service");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-0 enforcement on, TENANT nested create (real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: InstanceType<typeof PrismaService>;
  let ctx: TenantContextService;
  let tenantId: string;
  let billId: string | undefined;
  const slug = assertTestTenant(
    `qa-b929-${randomUUID().slice(0, 8)}-enforced`,
    "tenant-nested-walker.enforced.db.spec.ts",
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `B929 enforced ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    if (billId) await raw.vendorBill.deleteMany({ where: { id: billId } }); // items cascade
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
    delete process.env.TENANT_CONTEXT_ENFORCEMENT;
  }, 120_000);

  it("creates the bill and the item carries the context tenant (no TENANT_CONTEXT_MISSING)", async () => {
    const bill = await ctx.run(
      tenantId,
      () =>
        prisma.forTenant().vendorBill.create({
          data: {
            billNumber: `B929-${randomUUID().slice(0, 8)}`,
            totalOwed: 2,
            items: { create: [{ description: "Walker line", qty: 1, unitCost: 2 }] },
          },
        }),
      "ANONYMOUS",
      "B929Spec.enforced",
    );
    billId = bill.id;
    const items = await raw.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(items.map((i) => i.tenantId)).toEqual([tenantId]);
  });
});
