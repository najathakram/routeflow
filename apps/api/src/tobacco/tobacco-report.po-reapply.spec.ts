// `@LeaderCron` wraps every cron tick in a Postgres advisory lock; the report service is loaded here
// without a database, so the lock is a PASS-THROUGH (same guard as tobacco-report.service.spec.ts).
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { TobaccoReportService } from "./tobacco-report.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

/**
 * WHY `InventoryService.reversePoReceipts` REFUSES a regulated (`trackedCategoryId`) product.
 *
 * A PO re-apply is append-only: the original PURCHASE stays, a costed negative ADJUSTMENT compensates
 * it, and the receipt is re-posted as a NEW PURCHASE. The regulated purchase report sums
 * `type: "PURCHASE"` movements by effectiveAt — the compensating ADJUSTMENT is invisible to it — so it
 * would report the same delivery TWICE. This spec pins that mechanism against the real report
 * service, so the guard is not folklore: delete the guard and this is the report that gets filed.
 *
 * SA-808 §5: since the fix the compensation is itself a negative PURCHASE (dated at the receipt), so
 * the same report nets; the first case below is the LEGACY ledger (rows written before the fix), the
 * second is the ledger an edit writes now.
 */
describe("TobaccoReportService × a compensated-and-reposted PO receipt", () => {
  let service: TobaccoReportService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TobaccoReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
      ],
    }).compile();
    service = module.get(TobaccoReportService);
  });

  it("LEGACY ledger: counts the delivery twice — the report reads only PURCHASE rows, so an ADJUSTMENT compensation does not net the re-post", async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Cigarillos",
        sku: "C-1",
        unit: "pack",
        currentStock: D(10),
        averageCost: D(6),
      },
    ]);
    // What the ledger holds after ONE re-apply of a PO that received 10 packs, all in the same month:
    //   PURCHASE 10 @ $4 (original) · ADJUSTMENT −10 @ $4 (compensation) · PURCHASE 10 @ $6 (re-post).
    // The DB filter `type: "PURCHASE"` returns only the two PURCHASE rows.
    prisma.stockMovement.findMany
      .mockResolvedValueOnce([
        { productId: "p1", quantity: D(10), unitCost: D(4) },
        { productId: "p1", quantity: D(10), unitCost: D(6) },
      ])
      .mockResolvedValueOnce([]); // nothing after the period
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.tobaccoReport.findFirst.mockResolvedValue(null);
    prisma.tobaccoReport.create.mockResolvedValue({ id: "rep-1" });
    prisma.tenantConfig.findUnique.mockResolvedValue({ businessName: "Acme Wholesale" });

    await service.generateForPeriod(2026, 6, { userId: "user-1" });

    // the query itself is what excludes the ADJUSTMENT compensation …
    const purchaseQuery = prisma.stockMovement.findMany.mock.calls[0][0].where;
    expect(purchaseQuery.type).toBe("PURCHASE");
    // … so one delivery of 10 packs is filed as 20, and its value as $100 instead of $60
    const created = prisma.tobaccoReport.create.mock.calls[0][0].data;
    expect(created.totalQtyPurchased).toBe(20);
    expect(created.totalPurchaseValue).toBe(100);
    expect(created.totalQtyPurchased).not.toBe(10); // the true receipt
  });

  it("SA-808 §5: the compensation is a negative PURCHASE, so the same delivery is filed ONCE, at the edited cost", async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Cigarillos",
        sku: "C-1",
        unit: "pack",
        currentStock: D(10),
        averageCost: D(6),
      },
    ]);
    // The same re-apply, as written now:
    //   PURCHASE 10 @ $4 (original) · PURCHASE −10 @ $4 (compensation) · PURCHASE 10 @ $6 (re-post).
    prisma.stockMovement.findMany
      .mockResolvedValueOnce([
        { productId: "p1", quantity: D(10), unitCost: D(4) },
        { productId: "p1", quantity: D(-10), unitCost: D(4) },
        { productId: "p1", quantity: D(10), unitCost: D(6) },
      ])
      .mockResolvedValueOnce([]);
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.tobaccoReport.findFirst.mockResolvedValue(null);
    prisma.tobaccoReport.create.mockResolvedValue({ id: "rep-1" });
    prisma.tenantConfig.findUnique.mockResolvedValue({ businessName: "Acme Wholesale" });

    await service.generateForPeriod(2026, 6, { userId: "user-1" });

    const created = prisma.tobaccoReport.create.mock.calls[0][0].data;
    expect(created.totalQtyPurchased).toBe(10);
    expect(created.totalPurchaseValue).toBe(60);
  });
});
