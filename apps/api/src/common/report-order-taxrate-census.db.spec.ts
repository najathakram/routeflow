/**
 * DB-lane spec for `../../scripts/report-order-taxrate-census.mjs` (T15, SA-761 Order.taxRate census): the counts, the
 * proof classes and the "writes nothing" promise against a REAL Postgres. The pure parts are locked without a database by
 * the script's own `--self-test` (run by `report-scripts-ids-only.spec.ts`).
 *
 * The lane DB may hold other specs' production-class tenants, so the assertions are DELTAS: the census is run once before
 * this file seeds anything and once after, and the difference must be exactly the fixture. Collected only by
 * `jest.db.config.js`, run via `npm run local:test:db`. SAFETY (L-129): the spec's own qa- tenant (assertTestTenant), the
 * database must be provably local (requireLocalDatabaseUrl), afterAll deletes what this file created.
 */
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/report-order-taxrate-census.mjs");
const RUN = randomUUID().slice(0, 8);

type Block = {
  orders: number;
  stamped: Record<string, number>;
  unstamped: Record<string, number>;
  lines: number;
  linesUnstamped: number;
};

describeDb("report-order-taxrate-census.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  let tenantId = "";
  let customerId = "";
  let baseline: Block;

  const census = (): { total: Block } => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = dbUrl;
    const out = execFileSync("node", [CLI, "--json"], { cwd: API_DIR, encoding: "utf8", env });
    return JSON.parse(out);
  };
  const tableCounts = async () => ({
    orders: await prisma.order.count({ where: { tenantId } }),
    items: await prisma.orderItem.count({ where: { tenantId } }),
    stamped: await prisma.order.count({ where: { tenantId, taxRate: { not: null } } }),
  });

  let n = 0;
  const order = async (over: Record<string, unknown>) => {
    n += 1;
    return prisma.order.create({
      data: {
        tenantId,
        customerId,
        orderNumber: `ORD-TAXC-${RUN}-${n}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "DELIVERED",
        ...over,
      } as never,
    });
  };

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    baseline = census().total;

    const slug = assertTestTenant(`qa-taxcensus-${RUN}`, "report-order-taxrate-census.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `taxcensus ${slug}` } })).id;
    await prisma.systemConfig.create({
      data: { tenantId, key: "settings.taxRate", value: "8.25" },
    });
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "taxc", contactName: "taxc", tenantId } as never,
      })
    ).id;

    // stamped
    const stampedDefault = await order({
      taxRate: "0.0825",
      taxRateSource: "TENANT_DEFAULT",
      tax: 8.25,
    });
    await order({ taxRate: "0", taxRateSource: "CUSTOMER_EXEMPT" });
    await order({ taxRate: "0.07", taxRateSource: "LEGACY_INFERRED", tax: 7 });
    // unstamped, one per proof class
    const verified = await order({ tax: 8.25 }); // the tenant rate reproduces it
    await order({ tax: 6.6, discountAmount: 20 }); // 80 x 8.25%
    await order({ tax: 7.33 }); // another flat rate reproduces it
    await order({ subtotal: 100000, total: 100007.33, tax: 7.33 }); // nothing reproduces it
    await order({ subtotal: 0, total: 1, tax: 1 }); // tax on a zero subtotal
    await order({}); // no tax
    // out of scope
    await order({ status: "DRAFT", tax: 8.25 });
    await order({ status: "CANCELLED", tax: 8.25 });

    await prisma.orderItem.create({
      data: {
        orderId: stampedDefault.id,
        tenantId,
        name: "A",
        qty: "1",
        unitPrice: "1.00",
        taxRate: "0.0825",
      } as never,
    });
    await prisma.orderItem.create({
      data: { orderId: verified.id, tenantId, name: "B", qty: "1", unitPrice: "1.00" } as never,
    });
    await prisma.orderItem.create({
      data: {
        orderId: verified.id,
        tenantId,
        name: "C",
        qty: "1",
        unitPrice: "1.00",
        status: "CANCELLED",
      } as never,
    });
  }, 180_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.orderItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.systemConfig.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end();
  });

  it("counts exactly the fixture (draft and cancelled orders and cancelled lines are out of scope)", () => {
    const after = census().total;
    const d = (get: (b: Block) => number) => get(after) - get(baseline);
    expect(d((b) => b.orders)).toBe(9);
    expect(d((b) => b.stamped.tenantDefault)).toBe(1);
    expect(d((b) => b.stamped.customerExempt)).toBe(1);
    expect(d((b) => b.stamped.legacyInferred)).toBe(1);
    expect(d((b) => b.stamped.stampedNoSource)).toBe(0);
    expect(d((b) => b.unstamped.total)).toBe(6);
    expect(d((b) => b.unstamped.verified)).toBe(1);
    expect(d((b) => b.unstamped.verifiedNetOfDiscount)).toBe(1);
    expect(d((b) => b.unstamped.otherRate)).toBe(1);
    expect(d((b) => b.unstamped.unverified)).toBe(1);
    expect(d((b) => b.unstamped.subtotalZero)).toBe(1);
    expect(d((b) => b.unstamped.noTax)).toBe(1);
    expect(d((b) => b.lines)).toBe(2);
    expect(d((b) => b.linesUnstamped)).toBe(1);
  }, 120_000);

  it("writes nothing: the fixture's rows are identical after a run", async () => {
    const before = await tableCounts();
    census();
    expect(await tableCounts()).toEqual(before);
  }, 120_000);

  it("the JSON carries counts only: no id, slug or name of the fixture", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl };
    const out = execFileSync("node", [CLI, "--json"], { cwd: API_DIR, encoding: "utf8", env });
    expect(out).not.toContain(tenantId);
    expect(out).not.toContain(customerId);
    expect(out).not.toMatch(/qa-taxcensus/);
    expect(out).not.toMatch(/ORD-TAXC/);
  }, 120_000);
});
