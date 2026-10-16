/**
 * X3 (inventory TEST-PLAN W1b): foreign-tenant ids on every mutating inventory route.
 *
 * Tenants A and B each own a product. A caller authenticated as tenant A names tenant B's PRODUCT id on every
 * mutating inventory route that takes a product reference. Expected for every route: a 404 or 400 (the foreign
 * product does not exist for A) and ZERO rows written in either tenant: no movement, lot, PO / bill / count row,
 * no new variant, and B's (and A's) product rows byte-identical. A route that resolves, or fails with anything but
 * a 404/400 (a raw 500), or leaves a row behind is a tenant-isolation hole.
 *
 * One table of routes, one spec: adjust, purchase, PO create lines, PO update lines, PO receive (by productId),
 * bill create lines, bill update lines, count-session line, one-shot count commit, variant assign (foreign parent and
 * foreign target), cost basis (single and bulk) and reorder settings. The service layer is driven with tenant A's
 * context (`TenantContextService.run`), the way the controllers' tenant guard leaves it.
 *
 * RED on master (tests only, no fix), four routes: bill create lines and bill update lines both answer 200 and
 * PERSIST a bill line pointing at tenant B's product (bills / billItems changed); PO receive by a foreign productId
 * answers 200 and silently skips the line (no rows, wrong status); reorder settings answers a raw Prisma P2025 (500)
 * with no rows written. The other ten routes already refuse with 404/400. The last case pins that receiving the
 * bad bill does not move B's stock (the tenant scope on the in-tx product read skips the write) and is green.
 *
 * Each case fails on its OWN wrong value: the verdict ("RESOLVED" / the unexpected status) or the row diff.
 * Every case ends with expectLedgerConsistent (X1) for both tenants' products.
 *
 * Collected only by `jest.db.config.js`. Throwaway `qa-x3-<run>-a|b` tenants (assertTestTenant), spec-owned
 * fixtures, no live names; `afterAll` deletes what it created.
 */
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { InventoryService } from "./inventory.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  endLedgerHelperPool,
  expectLedgerConsistent,
  seedOpeningRow,
} from "./testing/ledger-consistency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

interface Fixture {
  tenantA: string;
  tenantB: string;
  userA: string;
  supplierA: string;
  productA: string;
  productB: string;
  poDraftA: string;
  poSentA: string;
  billDraftA: string;
  sessionA: string;
}

describeDb(
  "X3: foreign-tenant product ids on every mutating inventory route (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let inventory: InventoryService;
    let bills: VendorBillsService;
    let f: Fixture;
    const tenantIds: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InventoryService,
          VendorBillsService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: StockAlertService,
            useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
          },
          {
            provide: PlatformConfigService,
            useValue: {
              resolveAnthropicKey: jest.fn().mockResolvedValue(null),
              recordAiUsage: jest.fn(),
            },
          },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          {
            provide: DuplicateMatchService,
            useValue: {
              normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
              findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
              findScanDuplicate: jest.fn().mockResolvedValue(null),
            },
          },
          { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
          {
            provide: ProductAliasService,
            useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
          },
        ],
      }).compile();
      inventory = module.get(InventoryService);
      bills = module.get(VendorBillsService);

      const mkTenant = async (suffix: "a" | "b") => {
        const slug = assertTestTenant(
          `qa-x3-${RUN}-${suffix}`,
          "inventory-tenant-isolation.db.spec.ts",
        );
        const t = await prisma.tenant.create({ data: { slug, name: `x3 ${slug}` } });
        tenantIds.push(t.id);
        return { id: t.id, slug };
      };
      const a = await mkTenant("a");
      const b = await mkTenant("b");
      const mkProduct = async (tenantId: string, tag: string) => {
        const p = await prisma.product.create({
          data: {
            tenantId,
            name: `${tag} ${RUN}`,
            unit: "ea",
            pricePerUnit: 10,
            currentStock: 10,
            averageCost: 3,
            costingMethod: "AVCO",
            reorderPoint: 4,
            reorderQty: 6,
          },
        });
        await seedOpeningRow(pool as any, tenantId, p.id, 10);
        return p.id;
      };
      const userA = await prisma.user.create({
        data: {
          email: `${a.slug}@example.invalid`,
          username: a.slug,
          role: "OPERATOR",
          tenantId: a.id,
        },
      });
      const supplierA = await prisma.supplier.create({
        data: { name: `Sup ${RUN}`, tenantId: a.id },
      });
      const productA = await mkProduct(a.id, "prodA");
      const productB = await mkProduct(b.id, "prodB");
      const mkPo = async (n: number, status: "DRAFT" | "SENT") =>
        (
          await prisma.purchaseOrder.create({
            data: {
              tenantId: a.id,
              poNumber: `PO-X3-${RUN}-${n}`,
              supplierId: supplierA.id,
              status,
              totalAmount: 10,
              items: {
                create: [
                  {
                    tenantId: a.id,
                    productId: productA,
                    qtyOrdered: 5,
                    unitCost: 2,
                    totalCost: 10,
                  },
                ],
              },
            },
          })
        ).id;
      const bill = await prisma.vendorBill.create({
        data: {
          tenantId: a.id,
          billNumber: `BILL-X3-${RUN}`,
          supplierId: supplierA.id,
          status: "DRAFT",
          totalOwed: 10,
          billDate: new Date(),
          items: {
            create: [
              {
                tenantId: a.id,
                productId: productA,
                description: "A",
                qty: 5,
                unitCost: 2,
                lineTotal: 10,
              },
            ],
          },
        },
      });
      const session = await prisma.stockCountSession.create({
        data: { tenantId: a.id, name: `x3 ${RUN}`, startedById: userA.id },
      });
      f = {
        tenantA: a.id,
        tenantB: b.id,
        userA: userA.id,
        supplierA: supplierA.id,
        productA,
        productB,
        poDraftA: await mkPo(1, "DRAFT"),
        poSentA: await mkPo(2, "SENT"),
        billDraftA: bill.id,
        sessionA: session.id,
      };
    }, 120_000);

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const w = { where: { tenantId } };
        const billIds = (
          await prisma.vendorBill.findMany({ ...w, select: { id: true } }).catch(() => [])
        ).map((x) => x.id);
        await prisma.vendorBillItem
          .deleteMany({ where: { vendorBillId: { in: billIds } } })
          .catch(swallow);
        await prisma.vendorBill.deleteMany(w).catch(swallow);
        const poIds = (
          await prisma.purchaseOrder.findMany({ ...w, select: { id: true } }).catch(() => [])
        ).map((x) => x.id);
        await prisma.purchaseOrderItem
          .deleteMany({ where: { poId: { in: poIds } } })
          .catch(swallow);
        await prisma.purchaseOrder.deleteMany(w).catch(swallow);
        await prisma.stockCountLine.deleteMany(w).catch(swallow);
        await prisma.stockCountSession.deleteMany(w).catch(swallow);
        await prisma.stockLot.deleteMany(w).catch(swallow);
        await prisma.stockMovement.deleteMany(w).catch(swallow);
        await prisma.product
          .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
          .catch(swallow);
        await prisma.product.deleteMany(w).catch(swallow);
        await prisma.supplier.deleteMany(w).catch(swallow);
        await prisma.user.deleteMany(w).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await endLedgerHelperPool();
      await prisma?.$disconnect();
      await pool?.end();
    });

    /** Everything a route could write for either tenant, as comparable plain data. */
    async function snapshot() {
      const t = [f.tenantA, f.tenantB];
      const p = [f.productA, f.productB];
      const one = async (sql: string, params: unknown[]) =>
        (await pool.query(sql, params)).rows.map((r) => JSON.stringify(r));
      return {
        movements: await one(
          `SELECT id FROM "StockMovement" WHERE "tenantId" = ANY($1) OR "productId" = ANY($2) ORDER BY id`,
          [t, p],
        ),
        lots: await one(
          `SELECT id, "remainingQty" FROM "StockLot" WHERE "tenantId" = ANY($1) OR "productId" = ANY($2) ORDER BY id`,
          [t, p],
        ),
        purchaseOrders: await one(
          `SELECT id, "totalAmount", status FROM "PurchaseOrder" WHERE "tenantId" = ANY($1) ORDER BY id`,
          [t],
        ),
        purchaseOrderItems: await one(
          `SELECT i.id, i."productId", i."qtyOrdered", i."qtyReceived" FROM "PurchaseOrderItem" i
          WHERE i."productId" = ANY($2) OR i."tenantId" = ANY($1)
             OR i."poId" IN (SELECT id FROM "PurchaseOrder" WHERE "tenantId" = ANY($1)) ORDER BY i.id`,
          [t, p],
        ),
        bills: await one(
          `SELECT id, "totalOwed", status FROM "VendorBill" WHERE "tenantId" = ANY($1) ORDER BY id`,
          [t],
        ),
        billItems: await one(
          `SELECT i.id, i."productId", i.qty FROM "VendorBillItem" i
          WHERE i."productId" = ANY($2) OR i."tenantId" = ANY($1)
             OR i."vendorBillId" IN (SELECT id FROM "VendorBill" WHERE "tenantId" = ANY($1)) ORDER BY i.id`,
          [t, p],
        ),
        countSessions: await one(
          `SELECT id, status FROM "StockCountSession" WHERE "tenantId" = ANY($1) ORDER BY id`,
          [t],
        ),
        countLines: await one(
          `SELECT id, "productId", "countedQty" FROM "StockCountLine"
          WHERE "tenantId" = ANY($1) OR "productId" = ANY($2) ORDER BY id`,
          [t, p],
        ),
        products: await one(
          `SELECT to_jsonb(p) AS p FROM "Product" p WHERE p."tenantId" = ANY($1) ORDER BY p.id`,
          [t],
        ),
      };
    }

    const asA = <T>(fn: () => Promise<T>) => tenantCtx.run(f.tenantA, fn);
    const jwt = () => ({ sub: f.userA });

    /** [route name, the call, as tenant A, naming tenant B's product]. */
    const routes: Array<[string, () => Promise<unknown>]> = [
      [
        "adjust (POST movements/adjustment)",
        () =>
          inventory.recordAdjustment(
            { productId: f.productB, quantity: 5, notes: "x3" } as any,
            f.userA,
          ),
      ],
      [
        "purchase (POST movements/purchase)",
        () =>
          inventory.recordPurchase(
            { productId: f.productB, quantity: 5, unitCost: 2 } as any,
            f.userA,
          ),
      ],
      [
        "PO create lines (POST purchase-orders)",
        () =>
          inventory.createPurchaseOrder(
            { supplierId: f.supplierA, items: [{ productId: f.productB, qty: 5, unitCost: 2 }] },
            f.userA,
          ),
      ],
      [
        "PO update lines (PATCH purchase-orders/:id)",
        () =>
          inventory.updatePurchaseOrder(
            f.poDraftA,
            { items: [{ productId: f.productB, qtyOrdered: 5, unitCost: 2 }] } as any,
            f.userA,
          ),
      ],
      [
        "PO receive by productId (POST purchase-orders/:id/receive)",
        () =>
          inventory.receivePurchaseOrder(
            f.poSentA,
            { items: [{ productId: f.productB, receivedQty: 3 }] },
            f.userA,
          ),
      ],
      [
        "bill create lines (POST vendor-bills)",
        () =>
          bills.create({
            supplierId: f.supplierA,
            billDate: "2026-09-01",
            items: [{ productId: f.productB, description: "x3", qty: 5, unitCost: 2 }],
          }),
      ],
      [
        "bill update lines (PATCH vendor-bills/:id)",
        () =>
          bills.update(f.billDraftA, {
            items: [{ productId: f.productB, description: "x3", qty: 5, unitCost: 2 }],
          }),
      ],
      [
        "count line (PUT stock-counts/:id/lines)",
        () =>
          inventory.upsertStockCountLine(
            f.sessionA,
            { productId: f.productB, countedQty: 3 } as any,
            jwt(),
          ),
      ],
      [
        "count commit (POST stock-count/commit)",
        () =>
          inventory.commitStockCount(
            {
              sessionId: randomUUID(),
              items: [{ productId: f.productB, quantity: 3, mode: "REPLACE" }],
            } as any,
            f.userA,
          ),
      ],
      [
        "variant assign, foreign parent (POST variant-assign)",
        () =>
          inventory.assignToVariants(
            {
              parentProductId: f.productB,
              assignments: [{ newVariant: { name: `V ${RUN}` }, qty: 1 }],
            } as any,
            f.userA,
          ),
      ],
      [
        "variant assign, foreign target (POST variant-assign)",
        () =>
          inventory.assignToVariants(
            {
              parentProductId: f.productA,
              assignments: [{ productId: f.productB, qty: 1 }],
            } as any,
            f.userA,
          ),
      ],
      [
        "cost basis (PATCH products/:id/cost-basis)",
        () => inventory.setCostBasis(f.productB, { unitCost: 9 } as any, f.userA),
      ],
      [
        "cost basis bulk (POST cost-basis/bulk)",
        () =>
          inventory.bulkSetCostBasis(
            { items: [{ productId: f.productB, unitCost: 9 }] } as any,
            f.userA,
          ),
      ],
      [
        "reorder settings (PATCH products/:id/reorder-settings)",
        () => inventory.setReorderPoint(f.productB, 99, 99),
      ],
    ];

    it.each(routes)(
      "%s: 404/400 and 0 rows written in either tenant",
      async (_name, call) => {
        const before = await snapshot();

        const verdict = await asA(call).then(
          () => "RESOLVED",
          (e: any) => {
            const status = typeof e?.getStatus === "function" ? e.getStatus() : undefined;
            return status === 404 || status === 400
              ? "REFUSED"
              : `non-4xx ${status ?? e?.constructor?.name ?? typeof e}: ${String(e?.message ?? e).slice(0, 120)}`;
          },
        );
        const after = await snapshot();

        // The refusal and the row diff in one value, so a red shows BOTH wrong values (what answered, what was written).
        const changed = (Object.keys(before) as Array<keyof typeof before>).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
        );
        expect({ verdict, tablesChanged: changed }).toEqual({
          verdict: "REFUSED",
          tablesChanged: [],
        });
        expect(after).toEqual(before);
        await expectLedgerConsistent(f.tenantA, [f.productA]);
        await expectLedgerConsistent(f.tenantB, [f.productB]);
      },
      60_000,
    );

    it("impact: a tenant-A bill carrying tenant B's product line, once received, never moves B's stock", async () => {
      const bBefore = await prisma.product.findUniqueOrThrow({ where: { id: f.productB } });
      const bMovementsBefore = await prisma.stockMovement.count({
        where: { productId: f.productB },
      });
      // Once the create route refuses the foreign line (the X3 row above), there is no bill to receive and this holds.
      const bill = await asA(() =>
        bills.create({
          supplierId: f.supplierA,
          billDate: "2026-09-01",
          items: [{ productId: f.productB, description: "x3 impact", qty: 5, unitCost: 2 }],
        }),
      ).catch(() => null);
      // Observed on master: the bill is created and "received" (the foreign line is marked qtyReceived) but the tenant
      // scope on the in-tx product read skips the stock write, so B is untouched. This pins that B stays untouched.
      if (bill) {
        await asA(() =>
          bills.receive((bill as any).id, { acknowledgeUnlinked: true } as any),
        ).catch(() => null);
      }

      const bAfter = await prisma.product.findUniqueOrThrow({ where: { id: f.productB } });
      expect({
        stockOfB: Number(bAfter.currentStock),
        avgCostOfB: Number(bAfter.averageCost),
        movementsOfB: await prisma.stockMovement.count({ where: { productId: f.productB } }),
      }).toEqual({
        stockOfB: Number(bBefore.currentStock),
        avgCostOfB: Number(bBefore.averageCost),
        movementsOfB: bMovementsBefore,
      });
      await expectLedgerConsistent(f.tenantB, [f.productB]);
    }, 60_000);
  },
);
