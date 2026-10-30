/**
 * SA-927 PR-A cross-tenant refusal - a foreign tenant's product id handed to a public stock writer from
 * tenant A's context is refused with a 404 `NotFoundException("Product not found")`, writes no
 * StockMovement row, and leaves BOTH tenants' products (counter, average, ledger) untouched.
 * Real Postgres, throwaway `qa-sa927x-*` tenants. Expected PARTLY RED on master: every case is asserted
 * to the SA ruling, whatever master does today.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`). Run via `npm run local:test:db`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { InventoryService } from "./inventory.service";
import { bookRestockMovement } from "../returns/returns-restock.util";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { seedOpeningRow } from "./testing/ledger-consistency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-927 cross-tenant - a foreign product id is refused and nothing moves", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inventory: InventoryService;
  const tenants: Array<{ id: string; userId: string }> = [];
  let a = { id: "", userId: "", productId: "" };
  let b = { id: "", userId: "", productId: "" };

  async function makeTenant(label: string) {
    const slug = assertTestTenant(`qa-sa927x-${RUN}-${label}`, "sa927-cross-tenant.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-927x ${slug}` } });
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    tenants.push({ id: tenant.id, userId: user.id });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: `Widget ${slug}`,
        sku: `S927X-${RUN}-${label}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 10,
        averageCost: 2,
      },
    });
    await seedOpeningRow(pool, tenant.id, product.id, 10);
    return { id: tenant.id, userId: user.id, productId: product.id };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    inventory = module.get(InventoryService);
    a = await makeTenant("a");
    b = await makeTenant("b");
  }, 120_000);

  afterAll(async () => {
    for (const t of tenants) {
      const where = { where: { tenantId: t.id } };
      const steps: Array<() => Promise<unknown>> = [
        () => prisma.stockLot.deleteMany(where),
        () => prisma.stockMovement.deleteMany(where),
        () => prisma.auditLog.deleteMany(where),
        () => prisma.product.deleteMany(where),
        () => prisma.user.deleteMany(where),
        () => prisma.tenant.deleteMany({ where: { id: t.id } }),
      ];
      for (const step of steps) {
        // eslint-disable-next-line no-await-in-loop
        await step().catch(() => undefined);
      }
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  /** Every product's counter, average and movement count, read raw (no tenant scoping). */
  async function world() {
    const { rows } = await pool.query(
      `SELECT p.id, p."currentStock"::float8 AS stock, p."averageCost"::float8 AS avg,
              (SELECT count(*)::int FROM "StockMovement" m WHERE m."productId" = p.id) AS movements
         FROM "Product" p WHERE p.id = ANY($1::text[]) ORDER BY p.id`,
      [[a.productId, b.productId]],
    );
    return rows;
  }

  /** Runs `call` as tenant A with B's product id: it must 404 "Product not found" and move nothing. */
  async function expectRefused(call: () => Promise<unknown>) {
    const before = await world();
    let thrown: unknown;
    await tenantCtx
      .run(a.id, call)
      .then(() => undefined)
      .catch((e: unknown) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe("Product not found");
    // no movement row, both counters and the foreign average unchanged
    expect(await world()).toEqual(before);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "StockMovement" WHERE "productId" = $1`,
      [b.productId],
    );
    expect(rows[0].n).toBe(1); // the opening row only
  }

  it("recordAdjustment with a foreign product id: 404, no row, both products unchanged", async () => {
    await expectRefused(() =>
      inventory.recordAdjustment(
        { productId: b.productId, quantity: 5, reason: "FOUND" } as any,
        a.userId,
      ),
    );
  });

  it("recordPurchase with a foreign product id: 404, no row, both products unchanged", async () => {
    await expectRefused(() =>
      inventory.recordPurchase(
        { productId: b.productId, quantity: 5, unitCost: 4 } as any,
        a.userId,
      ),
    );
  });

  it("setCostBasis with a foreign product id: 404, no row, both products unchanged", async () => {
    await expectRefused(() =>
      inventory.setCostBasis(b.productId, { unitCost: 9, notes: "x" } as any, a.userId),
    );
  });

  // RED on master: the movement row is written, then tx.product.update() throws Prisma P2025 (not a 404);
  // the transaction rolls back, so nothing persists. Only the error class differs from the SA ruling.
  it("recordSale (inside A's tenantTransaction) with a foreign product id: 404, no row, both unchanged", async () => {
    await expectRefused(() =>
      prisma.tenantTransaction((tx) =>
        inventory.recordSale(b.productId, new Prisma.Decimal(3), "REF-XT", a.userId, tx),
      ),
    );
  });

  // RED on master: same as recordSale - P2025 from product.update() at returns-restock.util.ts, rolled back.
  it("bookRestockMovement (inside A's tenantTransaction) with a foreign product id: 404, no row, both unchanged", async () => {
    await expectRefused(() =>
      prisma.tenantTransaction((tx) =>
        bookRestockMovement(tx, {
          returnId: randomUUID(),
          productId: b.productId,
          pieces: new Prisma.Decimal(2),
          userId: a.userId,
        }),
      ),
    );
  });
});
