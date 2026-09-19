/**
 * DB-lane spec for the commerce fixtures in `apps/api/scripts/e2e-seed.js` (B566).
 *
 * The web e2e suite reads customers and products off a FRESH database: 06 CP-09 (priced product
 * rows), 08 ESC-01/ESC-02 (first customer in the builder's picker), 13 BOXED-01 (a boxed product
 * discovered by the product search), 06 CP-01 (an invoice row), 21 REG-B130 (customers list) and REG-B154 (>= 3 selectable
 * products). Before B566 the seed created users and addons but no customers/products, so those
 * six specs failed on a clean reset and only passed later as a side effect of other specs.
 *
 * This runs the REAL seed script (twice) against the local compose Postgres and asserts the
 * rows those specs need exist and that a re-run is idempotent (no duplicates). The tenant is the
 * standing approved test tenant `e2e-routeflow` — `assertTestTenant` inside the script guards it.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { spawnSync } from "child_process";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

const API_DIR = path.resolve(__dirname, "../..");
const SEED = path.resolve(API_DIR, "scripts/e2e-seed.js");
const TENANT_SLUG = "e2e-routeflow";

function runSeed(dbUrl: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  const res = spawnSync(process.execPath, [SEED], {
    cwd: API_DIR,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  // The script's own exit status is the contract: 0 = seeded, 1 = "❌ E2E seed failed".
  // (Jest's expect() takes ONE argument — no custom-message form — so throw with the output.)
  if (res.status !== 0) {
    throw new Error(`e2e-seed.js exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
}

describeDb("e2e-seed.js commerce fixtures (B566) — real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;

  const counts = async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
    const [customers, products, boxed, invoices, orders] = await Promise.all([
      prisma.customer.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          user: { username: { startsWith: "e2e_fixture_cust_" } },
        },
      }),
      prisma.product.count({
        where: { tenantId: tenant.id, isActive: true, sku: { startsWith: "E2E-FIX-" } },
      }),
      prisma.product.findFirst({ where: { tenantId: tenant.id, sku: "E2E-FIX-BOX" } }),
      prisma.invoice.count({
        where: { tenantId: tenant.id, invoiceNumber: "E2E-FIX-INV-001", status: "SENT" },
      }),
      // 06 CP-02/CP-06 + 21 REG-B24 need an ORDER with an active line on a catalog product.
      prisma.order.count({
        where: {
          tenantId: tenant.id,
          idempotencyKey: "e2e-fixture-order",
          status: "PENDING",
          lineItems: { some: { status: "PENDING", productId: { not: null } } },
        },
      }),
    ]);
    return { customers, products, boxed, invoices, orders };
  };

  beforeAll(() => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it("seeds >= 3 customers, >= 3 products and one boxed product, and a re-run adds nothing", async () => {
    runSeed(dbUrl);
    const first = await counts();

    expect(first.customers).toBeGreaterThanOrEqual(3);
    expect(first.products).toBeGreaterThanOrEqual(3);
    // 13 BOXED-01 discovers the boxed line by search ("case") and reads pack size off the row.
    expect(first.boxed).not.toBeNull();
    expect(first.boxed?.unitsPerBox).toBe(12);
    expect(first.boxed?.name.toLowerCase()).toContain("case");
    expect(Number(first.boxed?.pricePerUnit)).toBeGreaterThan(0);

    // 06 CP-01 scans real invoice amount cells only when the tenant has an invoice.
    expect(first.invoices).toBe(1);
    expect(first.orders).toBe(1);

    runSeed(dbUrl);
    const second = await counts();
    expect(second.invoices).toBe(1);
    expect(second.orders).toBe(1);
    expect(second.customers).toBe(first.customers);
    expect(second.products).toBe(first.products);
  }, 300_000);

  it("a customer SOFT-DELETED through the API is restored on re-seed — no duplicate user/customer (B566 follow-up)", async () => {
    runSeed(dbUrl);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
    const username = "e2e_fixture_cust_1";
    const user = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id, username },
    });
    const customer = await prisma.customer.findFirstOrThrow({ where: { userId: user.id } });

    // Exactly what customers.service.ts's soft-delete does (REG-B159): the customer is marked
    // deleted and the User's identity is RELEASED — renamed to a tombstone.
    await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        deletedAt: new Date(),
        username: `${username}~removed~${customer.id.slice(0, 8)}`,
        email: `removed+${customer.id}@placeholder.local`,
      },
    });

    runSeed(dbUrl);

    const users = await prisma.user.findMany({
      where: { tenantId: tenant.id, username: { startsWith: username } },
    });
    // The tombstone was restored, NOT duplicated. (Other leftover tombstones from an older
    // history are ignored — only NON-tombstone rows count.)
    const live = users.filter((u) => !u.username.includes("~removed~"));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: user.id, username, deletedAt: null });
    expect(live[0].email).toBe(`${username}@e2e-routeflow.test`);
    const allCustomers = await prisma.customer.count({
      where: { tenantId: tenant.id, user: { username: { startsWith: "e2e_fixture_cust_" } } },
    });
    expect(allCustomers).toBe(3); // no fourth (duplicate) customer
    expect((await counts()).customers).toBe(3); // and all three are active again
  }, 300_000);
});
