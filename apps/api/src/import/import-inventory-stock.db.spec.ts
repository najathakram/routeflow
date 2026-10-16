/**
 * B568 — real Postgres. The Zoho stock sync (`ImportService.importInventory`, existing-product branch)
 * moves the counter and writes its ADJUSTMENT row in ONE stock transaction, under the Product row lock,
 * from the LOCKED stock:
 *   (1) atomic — a StockMovement.create that throws leaves currentStock UNCHANGED and writes no row; a
 *       re-import of the same CSV then writes the ADJUSTMENT (the gap is not permanent);
 *   (2) serialized — a sale that commits while the import waits on the Product row lock is NOT lost:
 *       the import runs after it, on the locked value, and the stock ledger ends with drift 0
 *       (currentStock == sum of StockMovement.quantity).
 * Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes what it made. Runs on the DB lane
 * (`npm run local:test:db`); NOT run on a machine without Postgres.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("B568 Zoho stock sync is atomic and serialized with sales (real Postgres)", () => {
  let url: string;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        NumberingService,
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Product writes of the product importer only; this suite imports stock.
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn(),
            update: jest.fn(),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    importService = module.get(ImportService);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      const products = await prisma.product
        .findMany({ where: { tenantId }, select: { id: true } })
        .catch(() => [] as Array<{ id: string }>);
      const ids = products.map((p) => p.id);
      await prisma.stockMovement.deleteMany({ where: { productId: { in: ids } } }).catch(() => {});
      await prisma.stockMovement.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.product.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await prisma?.$disconnect();
  });

  /** A `qa-*` tenant, an actor user, and ONE product at `stock` with its opening PURCHASE row (drift 0). */
  async function seed(label: string, stock: number) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b568-${RUN}-${seq}-${label}`,
      "import-inventory-stock.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `qa ${slug}` } });
    tenantIds.push(tenant.id);
    const idBase = `${tenant.id}-actor`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "OPERATOR",
        tenantId: tenant.id,
      } as any,
    });
    const sku = `B568-${RUN}-${seq}`;
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: `Acme Widget ${sku}`,
        sku,
        barcode: sku,
        unit: "unit",
        pricePerUnit: 5,
        currentStock: stock,
      },
    });
    await prisma.stockMovement.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        type: "PURCHASE",
        quantity: stock,
        stockAfter: stock,
        notes: "qa opening stock",
      },
    });
    return { tenantId: tenant.id, userId: user.id, productId: product.id, sku };
  }

  /** The stock-ledger drift of a product: currentStock - sum(StockMovement.quantity). 0 = in balance. */
  async function drift(productId: string) {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT p."currentStock"::numeric AS stock,
                COALESCE((SELECT SUM(m.quantity) FROM "StockMovement" m WHERE m."productId" = p.id), 0)::numeric AS ledger,
                (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."productId" = p.id) AS movements
           FROM "Product" p WHERE p.id = $1`,
        [productId],
      );
      const r = rows[0] as { stock: string; ledger: string; movements: number };
      return {
        stock: Number(r.stock),
        ledger: Number(r.ledger),
        movements: r.movements,
        drift: Number(r.stock) - Number(r.ledger),
      };
    } finally {
      await c.end();
    }
  }

  /** Make the NEXT tenantTransaction's stockMovement.create throw (the update before it is in the same tx). */
  function breakNextMovementCreate() {
    const real = prisma.tenantTransaction.bind(prisma);
    jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts: any) =>
      real(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get: (t, k) =>
                k === "stockMovement"
                  ? new Proxy(t[k], {
                      get: (d, m) =>
                        m === "create"
                          ? async () => {
                              throw new Error("forced stockMovement.create failure");
                            }
                          : typeof d[m] === "function"
                            ? d[m].bind(d)
                            : d[m],
                    })
                  : t[k],
            }),
          ),
        opts,
      )) as any);
  }

  it("(1) a stockMovement.create that throws leaves currentStock unchanged and writes no row; the re-import then writes the ADJUSTMENT", async () => {
    const { tenantId, userId, productId, sku } = await seed("atomic", 100);
    const csv = `Item Name,SKU,Closing Stock\nAcme Widget ${sku},${sku},80\n`;

    breakNextMovementCreate();
    const failed = await tenantCtx.run(tenantId, () =>
      importService.importInventory(Buffer.from(csv), userId),
    );
    expect(failed.updated).toBe(0);
    expect(failed.skipped).toBe(1);
    // pre-fix: the counter already read 80 here with no ADJUSTMENT row (permanent gap)
    expect(await drift(productId)).toEqual({ stock: 100, ledger: 100, movements: 1, drift: 0 });

    const rerun = await tenantCtx.run(tenantId, () =>
      importService.importInventory(Buffer.from(csv), userId),
    );
    expect(rerun.updated).toBe(1);
    expect(await drift(productId)).toEqual({ stock: 80, ledger: 80, movements: 2, drift: 0 });
    const adj = await prisma.stockMovement.findFirstOrThrow({
      where: { productId, type: "ADJUSTMENT" },
    });
    expect(Number(adj.quantity)).toBe(-20);
    expect(Number(adj.stockAfter)).toBe(80);
  }, 30_000);

  it("(2) a sale committed while the import waits on the Product lock is not lost: ledger drift 0", async () => {
    const { tenantId, userId, productId, sku } = await seed("race", 100);
    const csv = `Item Name,SKU,Closing Stock\nAcme Widget ${sku},${sku},80\n`;
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let result: Awaited<ReturnType<ImportService["importInventory"]>>;
    let sawBlocked = false;
    try {
      // T2 plays the sale: it holds the Product row lock before the import's stock tx starts.
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "Product" WHERE id = $1 FOR UPDATE`, [productId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const t1 = tenantCtx.run(tenantId, () =>
        importService.importInventory(Buffer.from(csv), userId),
      );
      // ENTRY CONDITION, proven not timed: the import's stock tx is BLOCKED on T2's Product lock (it
      // pre-read currentStock = 100 by sku before the lock; pre-fix it never blocked at all).
      for (let i = 0; i < 400 && !sawBlocked; i++) {
        const { rows } = await t2.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        sawBlocked = rows[0].n > 0;
        if (!sawBlocked) await new Promise((r) => setTimeout(r, 25));
      }
      // the sale of 10: counter 100 -> 90 and its SALE row, in T2's transaction
      await t2.query(`UPDATE "Product" SET "currentStock" = "currentStock" - 10 WHERE id = $1`, [
        productId,
      ]);
      await t2.query(
        `INSERT INTO "StockMovement" (id, "productId", type, quantity, "stockAfter", "tenantId", notes)
         VALUES ($1, $2, 'SALE'::"MovementType", -10, 90, $3, 'qa sale')`,
        [randomUUID(), productId, tenantId],
      );
      await t2.query("COMMIT");
      result = await t1;
    } finally {
      await t2.end();
    }
    expect(sawBlocked).toBe(true);
    expect(result!.updated).toBe(1);
    // closing 80 vs the LOCKED 90 -> ADJUSTMENT -10 (pre-fix: a blind SET to 80 and a -20 row from
    // the stale 100, so the ledger summed to 70 against a counter of 80)
    const after = await drift(productId);
    expect(after).toEqual({ stock: 80, ledger: 80, movements: 3, drift: 0 });
    const adj = await prisma.stockMovement.findFirstOrThrow({
      where: { productId, type: "ADJUSTMENT" },
    });
    expect(Number(adj.quantity)).toBe(-10);
    expect(Number(adj.stockAfter)).toBe(80);
  }, 30_000);
});
