/**
 * Row 648: the vendor bill page stopped rendering `response.data.message`, so the refusals a user
 * needs explained carry CODES (and structured fields) the web builds fixed copy from. Each refusal
 * keeps its message text; the code and fields are what is new.
 */
import { Test, TestingModule } from "@nestjs/testing";
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

const D = (n: number) => new Prisma.Decimal(n);

describe("VendorBillsService — coded refusals the bill page explains (row 648)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
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
          provide: InventoryService,
          useValue: {
            recomputeProductInTx: jest.fn(),
            lockProducts: jest.fn(),
            fireStockAlerts: jest.fn(),
          },
        },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(VendorBillsService);
  });

  const refusal = async (run: () => Promise<unknown>) => {
    const err: any = await run().catch((e) => e);
    expect(err.getResponse).toBeDefined();
    return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
  };

  it("BILL_NOT_EDITABLE: an update of a non-DRAFT bill", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({ id: "b", status: "RECEIVED", items: [] });
    const { status, body } = await refusal(() => service.update("b", { notes: "x" }));
    expect(status).toBe(400);
    expect(body.code).toBe("BILL_NOT_EDITABLE");
    expect(body.message).toMatch(/Only DRAFT bills can be edited/);
  });

  it("BILL_PO_SUPPLIER_LOCKED: re-pointing a PO-linked bill's supplier", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "b",
      status: "DRAFT",
      supplierId: "sup-1",
      purchaseOrderId: "po-1",
      items: [],
    });
    const { status, body } = await refusal(() => service.update("b", { supplierId: "sup-2" }));
    expect(status).toBe(400);
    expect(body.code).toBe("BILL_PO_SUPPLIER_LOCKED");
  });

  it("rejects a reference from another business on an edit (no bill update)", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "b",
      status: "DRAFT",
      supplierId: "sup-1",
      purchaseOrderId: null,
      items: [],
    });
    prisma.supplier.findMany.mockResolvedValue([]); // not this tenant's supplier
    const err: any = await service
      .update("b", { supplierId: "other-biz-supplier" })
      .catch((e) => e);
    expect(err.getStatus()).toBe(404);
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("BILL_NEVER_RECEIVED: reverting a PARTIAL bill that was paid but never received", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "b",
      status: "PARTIAL",
      receivedDate: null,
      items: [],
    });
    const { status, body } = await refusal(() => service.revertToDraft("b", "user-1"));
    expect(status).toBe(400);
    expect(body.code).toBe("BILL_NEVER_RECEIVED");
  });

  it("RECEIVE_EXCEEDS_OUTSTANDING: names the product and carries both quantities", async () => {
    const item = {
      id: "item-1",
      productId: "prod-1",
      description: "Widget 24pk (invoice text)",
      qty: D(4),
      unitCost: D(3),
      packSize: null,
      qtyReceived: D(1),
      product: { id: "prod-1", name: "Widget 24pk", currentStock: D(0), averageCost: null },
    };
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "b",
      status: "PARTIAL",
      billNumber: "BILL-1",
      supplierId: "sup-1",
      receivedDate: new Date("2026-06-02"),
      purchaseOrderId: null,
      items: [item],
    });
    const { status, body } = await refusal(() =>
      service.receive("b", { items: [{ itemId: "item-1", qty: 5 }] } as never, "user-1"),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: "RECEIVE_EXCEEDS_OUTSTANDING",
      productName: "Widget 24pk",
      requested: "5",
      outstanding: "3",
    });
  });
});
