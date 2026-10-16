/**
 * Inventory TEST-PLAN W1b, rows R5 + R7 (RED on master, tests only): reverting a RECEIVED vendor bill to DRAFT.
 *
 *  R5 (B846)  revertToDraft must APPEND a reversal; today it DELETES the bill's PURCHASE StockMovement rows
 *             (`stockMovement.deleteMany` in VendorBillsService.revertToDraft), so the history of the receipt is erased
 *             and a filed period that counted it silently moves. Expected: the PURCHASE row survives AND a negative
 *             reversal row is added (reference = the bill number), the counter returns to the opening stock, and X1 holds.
 *  R7 (B639)  the reversal is keyed on the FREE-TEXT reference. A bill whose number equals another movement's
 *             reference (here a PO number "PO-1001" the same product and another product were received under) must
 *             touch only its own rows: the unrelated PURCHASE movement and the unrelated stock lots stay. Today the
 *             `deleteMany` (productId + reference + type) and `reverseBillLots` (reference only) take them too.
 *
 * Reds are real-Postgres; they fail on the bug's own wrong value (the surviving row counts), not on setup.
 * Collected only by `jest.db.config.js`. Throwaway `qa-vbrev-<run>-<n>` tenants approved by `assertTestTenant`;
 * spec-owned fixtures; `afterAll` deletes exactly what it created. Every case ends with expectLedgerConsistent (X1).
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
import {
  endLedgerHelperPool,
  expectLedgerConsistent,
  seedOpeningRow,
} from "../inventory/testing/ledger-consistency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb(
  "W1b R5 + R7: vendor-bill revertToDraft appends, and only its own rows (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let bills: VendorBillsService;
    const tenantIds: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
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
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const w = { where: { tenantId } };
        const rows = await prisma.vendorBill
          .findMany({ ...w, select: { id: true } })
          .catch(() => []);
        await prisma.vendorBillItem
          .deleteMany({ where: { vendorBillId: { in: rows.map((b) => b.id) } } })
          .catch(swallow);
        await prisma.vendorBill.deleteMany(w).catch(swallow);
        await prisma.stockLot.deleteMany(w).catch(swallow);
        await prisma.stockMovement.deleteMany(w).catch(swallow);
        await prisma.product.deleteMany(w).catch(swallow);
        await prisma.supplier.deleteMany(w).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await endLedgerHelperPool();
      await prisma?.$disconnect();
      await pool?.end();
    });

    async function seedWorld(label: string, billNumber: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-vbrev-${RUN}-${seq}-${label}`,
        "vendor-bill-revert.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `vbrev ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const supplier = await prisma.supplier.create({
        data: { name: `Supplier ${slug}`, tenantId },
      });
      const mkProduct = async (tag: string, opening: number) => {
        const p = await prisma.product.create({
          data: {
            tenantId,
            name: `${tag} ${slug}`,
            unit: "ea",
            pricePerUnit: 10,
            currentStock: opening,
            averageCost: 2,
            costingMethod: "AVCO",
          },
        });
        await seedOpeningRow(pool as any, tenantId, p.id, opening);
        return p.id;
      };
      const productA = await mkProduct("A", 10);
      const productB = await mkProduct("B", 3);
      const bill = await prisma.vendorBill.create({
        data: {
          tenantId,
          billNumber,
          supplierId: supplier.id,
          status: "DRAFT",
          totalOwed: 48,
          billDate: new Date(),
          items: {
            create: [
              {
                tenantId,
                productId: productA,
                description: "A x24",
                qty: 24,
                unitCost: 2,
                lineTotal: 48,
              },
            ],
          },
        },
      });
      const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
      return { tenantId, supplierId: supplier.id, productA, productB, billId: bill.id, inTenant };
    }

    const stock = async (productId: string) =>
      Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

    it("R5 (B846): reverting a received bill appends a reversal and keeps the PURCHASE row", async () => {
      const w = await seedWorld("r5", `BILL-R5-${RUN}`);
      await w.inTenant(() => bills.receive(w.billId));
      expect(await stock(w.productA)).toBe(34); // 10 opening + 24 received

      await w.inTenant(() => bills.revertToDraft(w.billId));

      expect(await stock(w.productA)).toBe(10); // the stock does come back (this part works on master)
      const own = await prisma.stockMovement.findMany({
        where: { productId: w.productA, reference: `BILL-R5-${RUN}` },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      // Expected: [PURCHASE +24, reversal -24]. Master DELETES the PURCHASE row, leaving no trace of the receipt.
      expect(own.map((m) => [m.type, Number(m.quantity)])).toEqual([
        ["PURCHASE", 24],
        [expect.any(String), -24],
      ]);
      await expectLedgerConsistent(w.tenantId, [w.productA, w.productB]);
    });

    it("R7 (B639): a bill numbered like another movement's reference reverts only its own rows", async () => {
      const SHARED = "PO-1001";
      const w = await seedWorld("r7", SHARED);
      // An unrelated receipt received under the SAME free-text reference: a PO "PO-1001" put 5 of A and 7 of B on
      // the shelf. Counters, opening rows, lots and PURCHASE movements are all consistent before the bill exists.
      const unrelated: { lotIds: string[]; movementIds: string[] } = {
        lotIds: [],
        movementIds: [],
      };
      for (const [productId, qty, opening] of [
        [w.productA, 5, 10],
        [w.productB, 7, 3],
      ] as const) {
        const lot = await prisma.stockLot.create({
          data: {
            tenantId: w.tenantId,
            productId,
            qty,
            remainingQty: qty,
            unitCost: 2,
            reference: SHARED,
          },
        });
        const mv = await prisma.stockMovement.create({
          data: {
            tenantId: w.tenantId,
            productId,
            type: "PURCHASE",
            quantity: qty,
            unitCost: 2,
            stockAfter: opening + qty,
            reference: SHARED,
            notes: "PO receipt (unrelated to the bill)",
            effectiveAt: new Date(Date.now() - 30 * 60_000),
            createdAt: new Date(Date.now() - 30 * 60_000),
          },
        });
        await prisma.product.update({
          where: { id: productId },
          data: { currentStock: opening + qty },
        });
        unrelated.lotIds.push(lot.id);
        unrelated.movementIds.push(mv.id);
      }

      await w.inTenant(() => bills.receive(w.billId));
      await w.inTenant(() => bills.revertToDraft(w.billId));

      // Wrong value on master: both unrelated lots are deleted by reference, and A's unrelated PURCHASE row is deleted
      // by (productId, reference, type) together with the bill's own.
      const lotsLeft = await prisma.stockLot.findMany({
        where: { id: { in: unrelated.lotIds } },
        select: { remainingQty: true },
      });
      const movementsLeft = await prisma.stockMovement.count({
        where: { id: { in: unrelated.movementIds } },
      });
      expect({
        unrelatedLotRemaining: lotsLeft.map((l) => Number(l.remainingQty)).sort(),
        unrelatedPurchaseRows: movementsLeft,
        stockA: await stock(w.productA), // 10 opening + 5 PO, the bill's own 24 reversed
        stockB: await stock(w.productB), // a bill that never carried B leaves it alone
      }).toEqual({
        unrelatedLotRemaining: [5, 7],
        unrelatedPurchaseRows: 2,
        stockA: 15,
        stockB: 10,
      });
      await expectLedgerConsistent(w.tenantId, [w.productA, w.productB]);
    });
  },
);
