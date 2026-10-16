/**
 * B1236: vendor-bill lines are validated against the caller's own catalog (real Postgres).
 *
 * Two throwaway catalogs, A and B, each own one product. The caller works in catalog A and names catalog B's
 * product id on a bill line, on create and on update. Expected: a 404 and ZERO rows written (bills and
 * billItems snapshotted for both catalogs before and after). A line naming a product of the caller's own
 * catalog still saves, so the check is not a blanket refusal. Receiving a bill never moves the other catalog's
 * stock.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-bill-lines-<run>-a|b` slugs
 * (assertTestTenant); `afterAll` deletes what the run created, in FK order.
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
import { VendorBillsService } from "./vendor-bills.service";
import { InventoryService } from "../inventory/inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

interface Fixture {
  catalogA: string;
  catalogB: string;
  supplierA: string;
  productA: string;
  productB: string;
  billDraftA: string;
}

describeDb("vendor bill lines are validated against the caller's catalog (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let bills: VendorBillsService;
  let f: Fixture;
  const catalogIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        InventoryService,
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
    bills = module.get(VendorBillsService);

    const mkCatalog = async (suffix: "a" | "b") => {
      const slug = assertTestTenant(
        `qa-bill-lines-${RUN}-${suffix}`,
        "vendor-bill-line-validation.db.spec.ts",
      );
      const t = await prisma.tenant.create({ data: { slug, name: `bill lines ${slug}` } });
      catalogIds.push(t.id);
      return t.id;
    };
    const catalogA = await mkCatalog("a");
    const catalogB = await mkCatalog("b");
    const mkProduct = async (tenantId: string, tag: string) =>
      (
        await prisma.product.create({
          data: {
            tenantId,
            name: `${tag} ${RUN}`,
            unit: "ea",
            pricePerUnit: 10,
            currentStock: 10,
            averageCost: 3,
            costingMethod: "AVCO",
          },
        })
      ).id;
    const supplierA = await prisma.supplier.create({
      data: { name: `Sup ${RUN}`, tenantId: catalogA },
    });
    const productA = await mkProduct(catalogA, "prodA");
    const productB = await mkProduct(catalogB, "prodB");
    const bill = await prisma.vendorBill.create({
      data: {
        tenantId: catalogA,
        billNumber: `BILL-LV-${RUN}`,
        supplierId: supplierA.id,
        status: "DRAFT",
        totalOwed: 10,
        billDate: new Date(),
        items: {
          create: [
            {
              tenantId: catalogA,
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
    f = {
      catalogA,
      catalogB,
      supplierA: supplierA.id,
      productA,
      productB,
      billDraftA: bill.id,
    };
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of catalogIds) {
      const w = { where: { tenantId } };
      const billIds = (
        await prisma.vendorBill.findMany({ ...w, select: { id: true } }).catch(() => [])
      ).map((x) => x.id);
      await prisma.billPayment.deleteMany(w).catch(swallow);
      await prisma.vendorBillItem
        .deleteMany({ where: { vendorBillId: { in: billIds } } })
        .catch(swallow);
      await prisma.vendorBill.deleteMany(w).catch(swallow);
      await prisma.stockLot.deleteMany(w).catch(swallow);
      await prisma.stockMovement.deleteMany(w).catch(swallow);
      await prisma.product.deleteMany(w).catch(swallow);
      await prisma.supplier.deleteMany(w).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** Everything the two routes could write, for both catalogs, as comparable plain data. */
  async function snapshot() {
    const t = [f.catalogA, f.catalogB];
    const p = [f.productA, f.productB];
    const rows = async (sql: string, params: unknown[]) =>
      (await pool.query(sql, params)).rows.map((r) => JSON.stringify(r));
    return {
      bills: await rows(
        `SELECT id, "totalOwed", status FROM "VendorBill" WHERE "tenantId" = ANY($1) ORDER BY id`,
        [t],
      ),
      billItems: await rows(
        `SELECT i.id, i."productId", i.qty FROM "VendorBillItem" i
          WHERE i."productId" = ANY($2) OR i."tenantId" = ANY($1)
             OR i."vendorBillId" IN (SELECT id FROM "VendorBill" WHERE "tenantId" = ANY($1))
          ORDER BY i.id`,
        [t, p],
      ),
      movements: await rows(
        `SELECT id FROM "StockMovement" WHERE "tenantId" = ANY($1) OR "productId" = ANY($2) ORDER BY id`,
        [t, p],
      ),
    };
  }

  const asA = <T>(fn: () => Promise<T>) => ctx.run(f.catalogA, fn);

  const verdictOf = (call: () => Promise<unknown>) =>
    asA(call).then(
      () => "RESOLVED",
      (e: any) => {
        const status = typeof e?.getStatus === "function" ? e.getStatus() : undefined;
        return status === 404
          ? "REFUSED"
          : `non-4xx ${status ?? e?.constructor?.name ?? typeof e}: ${String(e?.message ?? e).slice(0, 120)}`;
      },
    );

  const refusedRoutes: Array<[string, () => Promise<unknown>]> = [
    [
      "create refuses a line whose product is not in the caller's catalog",
      () =>
        bills.create({
          supplierId: f.supplierA,
          billDate: "2026-09-01",
          items: [{ productId: f.productB, description: "line", qty: 5, unitCost: 2 }],
        }),
    ],
    [
      "update refuses a line whose product is not in the caller's catalog",
      () =>
        bills.update(f.billDraftA, {
          items: [{ productId: f.productB, description: "line", qty: 5, unitCost: 2 }],
        }),
    ],
    [
      "create refuses when only one of several lines names a product outside the catalog",
      () =>
        bills.create({
          supplierId: f.supplierA,
          billDate: "2026-09-01",
          items: [
            { productId: f.productA, description: "ok", qty: 1, unitCost: 2 },
            { productId: f.productB, description: "bad", qty: 1, unitCost: 2 },
          ],
        }),
    ],
  ];

  it.each(refusedRoutes)(
    "%s: 404 and 0 rows written in either catalog",
    async (_name, call) => {
      const before = await snapshot();
      const verdict = await verdictOf(call);
      const after = await snapshot();
      const changed = (Object.keys(before) as Array<keyof typeof before>).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      // The refusal and the row diff in one value, so a red shows BOTH wrong values.
      expect({ verdict, tablesChanged: changed }).toEqual({
        verdict: "REFUSED",
        tablesChanged: [],
      });
      expect(after).toEqual(before);
    },
    60_000,
  );

  it("fence: create and update still save a line whose product is in the caller's catalog", async () => {
    const created: any = await asA(() =>
      bills.create({
        supplierId: f.supplierA,
        billDate: "2026-09-02",
        items: [{ productId: f.productA, description: "own", qty: 2, unitCost: 3 }],
      }),
    );
    expect(created.items.map((i: any) => i.productId)).toEqual([f.productA]);

    const updated: any = await asA(() =>
      bills.update(f.billDraftA, {
        items: [{ productId: f.productA, description: "own", qty: 4, unitCost: 3 }],
      }),
    );
    expect(updated.items.map((i: any) => [i.productId, Number(i.qty)])).toEqual([[f.productA, 4]]);
  }, 60_000);

  it("fence: free-text lines (no product) and a repeated product id still save on create and update", async () => {
    const lines = [
      { productId: null, description: "free text", qty: 1, unitCost: 2 },
      { productId: "", description: "empty id", qty: 1, unitCost: 2 },
      { productId: f.productA, description: "first", qty: 1, unitCost: 2 },
      { productId: f.productA, description: "again", qty: 2, unitCost: 2 },
    ];
    const created: any = await asA(() =>
      bills.create({ supplierId: f.supplierA, billDate: "2026-09-04", items: lines }),
    );
    expect(created.items.map((i: any) => i.productId).sort()).toEqual(
      [null, null, f.productA, f.productA].sort(),
    );

    const updated: any = await asA(() => bills.update(f.billDraftA, { items: lines }));
    expect(updated.items).toHaveLength(4);
    expect(updated.items.filter((i: any) => i.productId === f.productA)).toHaveLength(2);
  }, 60_000);

  it("receiving a bill never moves the other catalog's stock", async () => {
    const bBefore = await prisma.product.findUniqueOrThrow({ where: { id: f.productB } });
    const movementsBefore = await prisma.stockMovement.count({ where: { productId: f.productB } });
    const bill: any = await asA(() =>
      bills.create({
        supplierId: f.supplierA,
        billDate: "2026-09-03",
        items: [{ productId: f.productB, description: "impact", qty: 5, unitCost: 2 }],
      }),
    ).catch(() => null);
    if (bill) {
      await asA(() => bills.receive(bill.id, { acknowledgeUnlinked: true } as any)).catch(
        () => null,
      );
    }
    const bAfter = await prisma.product.findUniqueOrThrow({ where: { id: f.productB } });
    expect({
      stock: Number(bAfter.currentStock),
      avgCost: Number(bAfter.averageCost),
      movements: await prisma.stockMovement.count({ where: { productId: f.productB } }),
    }).toEqual({
      stock: Number(bBefore.currentStock),
      avgCost: Number(bBefore.averageCost),
      movements: movementsBefore,
    });
  }, 60_000);
});
