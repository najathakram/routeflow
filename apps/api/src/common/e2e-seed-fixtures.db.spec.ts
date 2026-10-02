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
 * The seed is `apps/api/scripts/e2e-seed.js`; to seed a local compose stack by hand run
 * `node scripts/local-env.mjs --db -- "node apps/api/scripts/e2e-seed.js"` (NOT `npm run local:seed`,
 * which runs prisma/seed.ts and never touches these fixtures).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { spawnSync } from "child_process";
import * as bcrypt from "bcrypt";
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

  it("B917: the harbor_cafe CUSTOMER login is linked to ONE live Customer, idempotently, and a soft-delete is repaired", async () => {
    runSeed(dbUrl);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
    const user = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id, username: "harbor_cafe", role: "CUSTOMER" },
    });
    const linked = await prisma.customer.findMany({ where: { userId: user.id } });
    // Without this row GET /orders answers the login 403 CUSTOMER_NOT_LINKED (the dashboard showed
    // "Could not load recent orders.").
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ tenantId: tenant.id, deletedAt: null });

    // re-run: still exactly one, same row
    runSeed(dbUrl);
    const again = await prisma.customer.findMany({ where: { userId: user.id } });
    expect(again.map((c) => c.id)).toEqual(linked.map((c) => c.id));

    // a soft-deleted link is restored, not duplicated
    await prisma.customer.update({ where: { id: linked[0].id }, data: { deletedAt: new Date() } });
    runSeed(dbUrl);
    const repaired = await prisma.customer.findMany({ where: { userId: user.id } });
    expect(repaired).toHaveLength(1);
    expect(repaired[0].deletedAt).toBeNull();
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

  it("seeds an approved buyer on a dedicated customer, idempotently, with no address or rule baked in", async () => {
    runSeed(dbUrl);
    runSeed(dbUrl);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
    const email = "e2e_buyer@e2e-routeflow.test";

    const accounts = await prisma.buyerAccount.findMany({ where: { email } });
    expect(accounts).toHaveLength(1); // a re-run never duplicates the buyer
    expect(accounts[0]).toMatchObject({ status: "ACTIVE", deletedAt: null });
    // A re-seed must not rotate a valid hash: a minted buyer.json depends on the password
    // still verifying after the second run.
    expect(await bcrypt.compare("BuyerPortal1!", accounts[0].passwordHash)).toBe(true);

    const links = await prisma.customerLink.findMany({
      where: { buyerAccountId: accounts[0].id },
      include: { customer: { include: { user: true } } },
    });
    expect(links).toHaveLength(1);
    // "Approved" is ACTIVE (the enum default is INVITED) on the approved test tenant.
    expect(links[0]).toMatchObject({ status: "ACTIVE", tenantId: tenant.id });
    // Dedicated customer: CustomerLink.customerId is @unique, so harbor_cafe stays free.
    expect(links[0].customer.user.username).toBe("e2e_buyer_cust");

    // Per-proof state (a billing address, a selling rule) is set and undone by the prover, so the
    // resting fixture carries no address on its customer.
    expect(await prisma.customerAddress.count({ where: { customerId: links[0].customerId } })).toBe(
      0,
    );
  }, 300_000);

  // #2195: the units e2e lane (#2233) and any unit-label screenshot need a tenant granted
  // flag.units_v1 and a product with a Piece/Case ladder. Before this, POST .../units was a 403
  // PLAN_GATE on e2e-routeflow, so those states were "not capturable".
  it("grants flag.units_v1 to e2e-routeflow ONLY, with one Piece/Case x12 product, idempotently (#2195)", async () => {
    // A stale DENY left by a spec must not survive a re-seed: the canary state is deterministic.
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
    await prisma.tenantFeatureOverride.updateMany({
      where: { tenantId: tenant.id, featureKey: "flag.units_v1", revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.tenantFeatureOverride.create({
      data: {
        tenantId: tenant.id,
        featureKey: "flag.units_v1",
        effect: "DENY",
        kind: "SUPPORT",
        reason: "#2195 spec: a stale DENY the re-seed must replace",
      },
    });

    runSeed(dbUrl);
    runSeed(dbUrl);

    const active = await prisma.tenantFeatureOverride.findMany({
      where: { tenantId: tenant.id, featureKey: "flag.units_v1", revokedAt: null },
    });
    expect(active.map((r) => ({ effect: r.effect, expiresAt: r.expiresAt }))).toEqual([
      { effect: "GRANT", expiresAt: null },
    ]);

    // Never any other tenant: the seed writes units_v1 overrides for e2e-routeflow alone.
    const elsewhere = await prisma.tenantFeatureOverride.count({
      where: {
        featureKey: "flag.units_v1",
        tenantId: { not: tenant.id },
        reason: { contains: "e2e-seed" },
      },
    });
    expect(elsewhere).toBe(0);

    const products = await prisma.product.findMany({
      where: { tenantId: tenant.id, sku: "E2E-FIX-UNITS" },
      include: { units: true },
    });
    expect(products).toHaveLength(1);
    const [p] = products;
    expect(p.isActive).toBe(true);
    // Piece is the product itself (factor 1, no pack); Case is a real ProductUnit row at 12 —
    // ProductUnitsService refuses a factor-1 row when the pack is itself factor 1.
    expect(p.unitsPerBox ?? 1).toBeLessThanOrEqual(1);
    expect(p.trackedCategoryId).toBeNull();
    expect(p.units.map((u) => ({ label: u.label, factorToBase: u.factorToBase }))).toEqual([
      { label: "Case", factorToBase: 12 },
    ]);
    expect(p.units[0].tenantId).toBe(tenant.id);
    // Never matched by 13-boxed-order-entry's "case" product search.
    expect(p.name.toLowerCase()).not.toContain("case");
  }, 300_000);
});
