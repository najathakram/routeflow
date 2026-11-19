import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";

/**
 * Units/PO step 7 — a vendor bill linked to a purchase order:
 *  - create() links an existing PO (validated, one bill per PO, hard-gated against
 *    the PO) or raises a DRAFT PO from its own lines in the same transaction;
 *  - update() keeps a linked draft bill within the PO;
 *  - guard (e): a PO-linked bill NEVER touches stock on receive / revert / void —
 *    the PO is the stock mover, so a scanned delivery is never counted twice.
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

const D = (n: number | string) => new Prisma.Decimal(n);

/** A PO for 24 pieces of prod-1 @ $1.25/piece. */
const po = (o: Record<string, unknown> = {}) => ({
  id: "po-1",
  poNumber: "PO-2026-0001",
  supplierId: "sup-1",
  status: "SENT",
  items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: D(24), unitCost: D(1.25) }],
  ...o,
});

/** One case of 24 @ $30 == 24 pieces @ $1.25 — within the PO above. */
const billLine = (o: Record<string, unknown> = {}) => ({
  productId: "prod-1",
  description: "Widget 24pk",
  qty: 1,
  unitCost: 30,
  packSize: 24,
  sku: "W-24",
  ...o,
});

const linkedItem = (o: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Widget 24pk",
  qty: D(1),
  unitCost: D(30),
  packSize: 24,
  qtyReceived: null as Prisma.Decimal | null,
  product: { id: "prod-1", name: "Widget 24pk", currentStock: D(0), averageCost: null },
  ...o,
});

const bill = (o: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0042",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  receivedDate: null as Date | null,
  purchaseOrderId: null as string | null,
  totalPaid: D(0),
  items: [linkedItem()],
  supplier: { id: "sup-1", name: "Acme Supply" },
  ...o,
});

describe("B844 vendor bill number is minted inside the creating transaction", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let inventory: {
    recomputeProductInTx: jest.Mock;
    lockProducts: jest.Mock;
    fireStockAlerts: jest.Mock;
    createDraftPurchaseOrderInTx: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    wireStockHelper(prisma);
    // R5-5: refs resolve inside the tenant unless a test says otherwise.
    prisma.supplier.findMany.mockImplementation(async (args: any) =>
      (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
    );
    // B1236: bill lines are validated against the catalog; by default every named id resolves.
    prisma.product.findMany.mockImplementation(async (args: any) =>
      (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
    );
    // receive() re-reads the bill inside its transaction (B285 row lock): repeat the last bill read
    prisma.vendorBill.findUnique.mockImplementation(
      () =>
        prisma.vendorBill.findUnique.mock.results.filter((r) => r.type === "return").at(-1)?.value,
    );
    inventory = {
      recomputeProductInTx: jest.fn(),
      lockProducts: jest.fn(),
      fireStockAlerts: jest.fn(),
      createDraftPurchaseOrderInTx: jest
        .fn()
        .mockResolvedValue({ id: "po-new", poNumber: "PO-2026-0002", status: "DRAFT" }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformConfigService,
          useValue: {
            prepareAiCall: jest.fn().mockResolvedValue({
              key: null,
              source: "routeflow",
              model: "",
              tenantId: "test-tenant",
            }),
            requireAiTenant: jest.fn(),
            recordAiUsage: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: DuplicateMatchService,
          useValue: {
            normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
            findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
            findScanDuplicate: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: InventoryService, useValue: inventory },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(VendorBillsService);
    prisma.vendorBill.create.mockResolvedValue({ id: "bill-new" });
  });

  /** The order the create path touched the lock, the number read and the insert, across tx and non-tx handles. */
  function trace() {
    const events: string[] = [];
    prisma.txExecuteRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (String(strings?.join?.(" ") ?? strings).includes("pg_advisory_xact_lock")) {
        events.push("lock");
      }
      return 0;
    });
    prisma.vendorBill.findFirst.mockImplementation(async () => {
      events.push("read-last-number");
      return { billNumber: "BILL-2026-0005" };
    });
    prisma.vendorBill.create.mockImplementation(async (args: any) => {
      events.push("insert:" + args.data.billNumber);
      return { id: "bill-new" };
    });
    prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => {
      events.push("tx-open");
      return prisma.$transaction(fn);
    });
    return events;
  }

  it("takes the per-tenant number lock, then reads the last number, then inserts - all inside one tx", async () => {
    const events = trace();
    await service.create({ supplierId: "sup-1", items: [billLine()] });
    expect(events).toEqual(["tx-open", "lock", "read-last-number", "insert:BILL-2026-0006"]);
  });

  it("mints the next number from the last one read under the lock", async () => {
    trace();
    await service.create({ supplierId: "sup-1", items: [billLine()] });
    expect(prisma.vendorBill.create.mock.calls[0][0].data.billNumber).toBe("BILL-2026-0006");
  });
});
