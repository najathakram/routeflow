/**
 * B710 / SA-148: DB-lane proof that one invoice scan backs at most one live bill under a REAL race.
 *
 * The mock-level spec (vendor-bills.service.spec.ts, "claiming the originating scan (B710)") pins the
 * guarded `updateMany` shapes; only Postgres can prove the row lock serializes two transactions. Each race
 * holds BOTH posts at a barrier just before `claimScanInTx`, so both transactions are open with their own
 * bill row written, then releases them together: one claim takes the scan row, the other blocks on it,
 * re-evaluates the guard after the winner commits, matches nothing and answers 409 — rolling its bill back.
 *
 *  (a) a fresh scan posted twice at once  -> exactly one bill, the loser 409 SCAN_ALREADY_POSTED;
 *  (b) a scan whose bill was VOIDed, re-posted twice at once -> exactly one new live bill, loser 409.
 *
 * `nextBillNumber` is stubbed to hand out distinct numbers: it is a read-then-write outside the transaction,
 * so two concurrent creates can collide on the bill number (P2002) before either reaches the claim. That is a
 * separate defect reported on its own; stubbing it keeps this spec about the scan claim alone.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a throwaway
 * `qa-scan-claim-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the rows
 * this run created, in FK order.
 *
 * NOT EXECUTED by the authoring session (no Postgres on that host) — the PC lane runs it.
 */

// VendorBillsService imports these at module scope for scanInvoice(); mock them so loading the
// service here never reaches a real SDK / native binary (same guard as the mock-level specs).
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
import { ConflictException } from "@nestjs/common";
import { randomUUID } from "crypto";
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

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-scan-claim-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "vendor-bills.scan-claim.db.spec.ts",
  );
};

describeDb("vendor bill ↔ invoice scan claim — real Postgres race (B710 / SA-148)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  const createdTenantIds: string[] = [];
  let billSeq = 0;

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
    // Distinct numbers per create (see the header): this spec is about the scan claim only.
    jest
      .spyOn(bills as any, "nextBillNumber")
      .mockImplementation(async () => `BILL-QA${RUN_SUFFIX}-${String(++billSeq).padStart(4, "0")}`);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.invoiceScan.deleteMany({ where: { tenantId } });
    await prisma.billPayment.deleteMany({ where: { tenantId } });
    const billRows = await prisma.vendorBill.findMany({
      where: { tenantId },
      select: { id: true },
    });
    await prisma.vendorBillItem.deleteMany({
      where: { vendorBillId: { in: billRows.map((b) => b.id) } },
    });
    await prisma.vendorBill.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    supplierId: string;
    productId: string;
    scanId: string;
  }

  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `Scan claim ${slug}` } });
    createdTenantIds.push(tenant.id);
    const supplier = await prisma.supplier.create({
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 0,
        averageCost: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    const scan = await prisma.invoiceScan.create({
      data: { tenantId: tenant.id, fileHash: `qa-${slug}`, extractedPayload: {} },
    });
    return {
      tenantId: tenant.id,
      supplierId: supplier.id,
      productId: product.id,
      scanId: scan.id,
    };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  const postDto = (w: World) => ({
    supplierId: w.supplierId,
    billDate: "2026-09-01",
    scanId: w.scanId,
    items: [{ productId: w.productId, description: "Widget", qty: 3, unitCost: 4 }],
  });

  /**
   * Hold every `claimScanInTx` call until `parties` callers are inside it (each with its own open
   * transaction and bill row), then let them all claim at once. Times out open, never hangs.
   */
  function claimBarrier(parties: number) {
    const original = (VendorBillsService.prototype as any).claimScanInTx;
    let arrived = 0;
    let release!: () => void;
    const allIn = new Promise<void>((r) => (release = r));
    const spy = jest.spyOn(bills as any, "claimScanInTx").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      arrived += 1;
      if (arrived >= parties) release();
      await Promise.race([allIn, new Promise((r) => setTimeout(r, 5000))]);
      return original.apply(bills, args);
    });
    return { spy, arrivedCount: () => arrived };
  }

  const liveBills = (w: World) =>
    prisma.vendorBill.findMany({
      where: { tenantId: w.tenantId, status: { not: "VOID" } },
      select: { id: true },
    });

  it("(a) a fresh scan posted twice at once: exactly one bill, the loser 409 SCAN_ALREADY_POSTED", async () => {
    const w = await seedWorld("fresh");
    const barrier = claimBarrier(2);

    const results = await Promise.allSettled([
      inTenant(w, () => bills.create(postDto(w))),
      inTenant(w, () => bills.create(postDto(w))),
    ]);
    barrier.spy.mockRestore();

    expect(barrier.arrivedCount()).toBe(2); // both transactions really reached the claim together
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect(lost[0].reason.getResponse()).toMatchObject({ code: "SCAN_ALREADY_POSTED" });

    const all = await prisma.vendorBill.findMany({ where: { tenantId: w.tenantId } });
    expect(all).toHaveLength(1); // the loser's bill rolled back with its transaction
    expect(all[0].id).toBe(won[0].value.id);
    const scan = await prisma.invoiceScan.findUniqueOrThrow({ where: { id: w.scanId } });
    expect(scan).toMatchObject({ status: "POSTED", vendorBillId: won[0].value.id });
  });

  it("(b) a scan whose bill was VOIDed, re-posted twice at once: exactly one new live bill, loser 409", async () => {
    const w = await seedWorld("void");
    const first = await inTenant(w, () => bills.create(postDto(w)));
    await inTenant(w, () => bills.voidBill(first.id));
    expect(await liveBills(w)).toHaveLength(0);

    const barrier = claimBarrier(2);
    const results = await Promise.allSettled([
      inTenant(w, () => bills.create(postDto(w))),
      inTenant(w, () => bills.create(postDto(w))),
    ]);
    barrier.spy.mockRestore();

    expect(barrier.arrivedCount()).toBe(2);
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect(lost[0].reason.getResponse()).toMatchObject({ code: "SCAN_ALREADY_POSTED" });

    const live = await liveBills(w);
    expect(live.map((b) => b.id)).toEqual([won[0].value.id]); // one live bill, the loser rolled back
    expect(await prisma.vendorBill.count({ where: { tenantId: w.tenantId } })).toBe(2); // + the void one
    const scan = await prisma.invoiceScan.findUniqueOrThrow({ where: { id: w.scanId } });
    expect(scan).toMatchObject({ status: "POSTED", vendorBillId: won[0].value.id });
  });
});
