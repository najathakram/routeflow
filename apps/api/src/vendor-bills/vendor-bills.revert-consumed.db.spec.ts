/**
 * Row 645 follow-up (R5 part 2, builder B) against real Postgres: since #3487 a sale never lowers
 * `StockLot.remainingQty`, so a bill revert reads "how much was used" from the LEDGER. A received lot whose
 * goods were sold is zeroed with "(bill reversed; up to N already consumed)", never deleted; a second bill for the
 * same product does not inflate N; an untouched lot is still deleted. Throwaway `qa-r645-*` tenants.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Run with `npm run local:test:db`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory/inventory.service";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-r645-${RUN_SUFFIX}-${tenantSeq}-${label}`, "bill-revert-consumed");
};

/** The bill month is LAST month (a completed month, so a tobacco report may exist); today is open. */
const today = new Date();
const BILL_Y = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
const BILL_M = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth(); // 1-12
const BILL_DATE = `${BILL_Y}-${String(BILL_M).padStart(2, "0")}-15`;
const MONTH_START = new Date(Date.UTC(BILL_Y, BILL_M - 1, 1));
const MONTH_END_EXCL = new Date(Date.UTC(BILL_Y, BILL_M, 1));
describeDb(
  "row 645 follow-up: a bill revert reads consumption from the ledger — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let bills: VendorBillsService;
    let inventory: InventoryService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
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
      inventory = module.get(InventoryService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await (async () => {
          const vb = await prisma.vendorBill.findMany({
            where: { tenantId },
            select: { id: true },
          });
          const billIds = vb.map((b) => b.id);
          await prisma.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } });
          await prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } });
          await prisma.vendorBill.deleteMany({ where: { tenantId } });
          await prisma.auditLog.deleteMany({ where: { tenantId } });
          await prisma.regulatedFiling.deleteMany({ where: { tenantId } });
          await prisma.tobaccoReport.deleteMany({ where: { tenantId } });
          await prisma.stockLot.deleteMany({ where: { tenantId } });
          await prisma.stockMovement.deleteMany({ where: { tenantId } });
          await prisma.product.deleteMany({ where: { tenantId } });
          await prisma.trackedCategory.deleteMany({ where: { tenantId } });
          await prisma.supplierCredit.deleteMany({ where: { tenantId } });
          await prisma.supplier.deleteMany({ where: { tenantId } });
          await prisma.user.deleteMany({ where: { tenantId } });
          await prisma.tenant.delete({ where: { id: tenantId } });
        })().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`bill-revert-consumed cleanup failed for tenant ${tenantId}:`, e);
        });
      }
      await prisma.$disconnect();
    });

    interface World {
      tenantId: string;
      userId: string;
      supplierId: string;
      productId: string;
      categoryId: string | null;
    }

    async function seedWorld(
      label: string,
      kind: "plain" | "tobacco" | "tracked" = "plain",
    ): Promise<World> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({
        data: { slug, name: `Revert consumed ${slug}` },
      });
      createdTenantIds.push(tenant.id);
      const user = await prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "OPERATOR",
          tenantId: tenant.id,
        },
      });
      const supplier = await prisma.supplier.create({
        data: { name: `Supplier ${slug}`, tenantId: tenant.id },
      });
      const category =
        kind === "tracked"
          ? await prisma.trackedCategory.create({
              data: { name: `Cat ${slug}`, tenantId: tenant.id, reportCadence: "MONTHLY" },
            })
          : null;
      const product = await prisma.product.create({
        data: {
          name: `Widget ${slug}`,
          unit: "ea",
          pricePerUnit: 10,
          currentStock: 0,
          costingMethod: "AVCO",
          tenantId: tenant.id,
          isTobacco: kind === "tobacco",
          trackedCategoryId: category?.id ?? null,
        },
      });
      return {
        tenantId: tenant.id,
        userId: user.id,
        supplierId: supplier.id,
        productId: product.id,
        categoryId: category?.id ?? null,
      };
    }

    const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

    // `create()` ignores any caller-supplied bill number and assigns the next `BILL-YYYY-NNNN`
    // (vendor-bills.service.ts `nextBillNumber`), so a test that needs the number reads it back.
    async function createBill(w: World, qty: number, date = BILL_DATE) {
      const bill: any = await inTenant(w, () =>
        bills.create({
          supplierId: w.supplierId,
          billDate: date,
          items: [{ productId: w.productId, description: "Widget", qty, unitCost: 2 }],
        } as never),
      );
      return { id: bill.id as string, billNumber: bill.billNumber as string };
    }
    const receive = (w: World, id: string) =>
      inTenant(w, () => bills.receive(id, undefined, w.userId) as Promise<unknown>);
    async function receiveBill(w: World, qty: number, date = BILL_DATE) {
      const { id } = await createBill(w, qty, date);
      await receive(w, id);
      return id;
    }
    const revert = (w: World, id: string) =>
      inTenant(w, () => bills.revertToDraft(id, w.userId) as Promise<unknown>);
    const rereceive = async (w: World, id: string, qty: number) => {
      await inTenant(w, () =>
        bills.update(id, {
          items: [{ productId: w.productId, description: "Widget", qty, unitCost: 2 }],
        } as never),
      );
      await inTenant(w, () => bills.receive(id, undefined, w.userId));
    };

    const TODAY = new Date().toISOString().slice(0, 10);
    /** A sale of `qty` after the bill-month receipt: one SALE ledger row, the counter lowered with it. */
    async function sell(w: World, qty: number, effectiveAt: Date) {
      await prisma.stockMovement.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          type: "SALE",
          quantity: -qty,
          effectiveAt,
          notes: "spec sale",
        } as never,
      });
      await prisma.product.update({
        where: { id: w.productId },
        data: { currentStock: { decrement: qty } },
      });
    }
    const lotsOf = (w: World) =>
      prisma.stockLot.findMany({
        where: { tenantId: w.tenantId, productId: w.productId },
        orderBy: { purchaseDate: "asc" },
      });

    it("REG: a received lot whose goods were sold is ZEROED with the consumed count, never deleted", async () => {
      const w = await seedWorld("sold");
      const id = await receiveBill(w, 10);
      const [lot] = await lotsOf(w);
      expect(Number(lot.remainingQty)).toBe(10);
      await sell(w, 3, new Date());
      // #3487: the sale does not lower the lot; only the ledger moves.
      expect(Number((await lotsOf(w))[0].remainingQty)).toBe(10);

      await revert(w, id);

      const after = await lotsOf(w);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(lot.id);
      expect(Number(after[0].remainingQty)).toBe(0);
      expect(after[0].notes ?? "").toContain("(bill reversed; up to 3 already consumed)");
    });

    it("an untouched lot (nothing sold after the receipt) is still deleted on revert", async () => {
      const w = await seedWorld("untouched");
      const id = await receiveBill(w, 10);
      await revert(w, id);
      expect(await lotsOf(w)).toHaveLength(0);
    });

    it("a second bill for the same product does not inflate N; its own untouched lot reverts cleanly", async () => {
      const w = await seedWorld("second");
      const first = await receiveBill(w, 10); // bill month (last month)
      const saleAt = new Date(new Date(`${BILL_DATE}T12:00:00Z`).getTime() + 86_400_000);
      await sell(w, 3, saleAt); // after the first receipt, before the second on both clocks
      const second = await receiveBill(w, 5, TODAY);

      await revert(w, first);
      const lots = await lotsOf(w);
      const zeroed = lots.find((l) => Number(l.qty) === 10)!;
      const other = lots.find((l) => Number(l.qty) === 5)!;
      expect(Number(zeroed.remainingQty)).toBe(0);
      expect(zeroed.notes ?? "").toContain("(bill reversed; up to 3 already consumed)");
      expect(Number(other.remainingQty)).toBe(5);

      await revert(w, second);
      const left = await lotsOf(w);
      expect(left.map((l) => Number(l.qty))).toEqual([10]); // the second bill's lot is gone, untouched
    });

    it("N is capped at the lot's size: selling more than the bill received reports the lot size", async () => {
      const w = await seedWorld("over");
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 20 } });
      const id = await receiveBill(w, 4);
      await sell(w, 9, new Date());
      await revert(w, id);
      const [lot] = await lotsOf(w);
      expect(Number(lot.remainingQty)).toBe(0);
      expect(lot.notes ?? "").toContain("(bill reversed; up to 4 already consumed)");
    });
  },
);
