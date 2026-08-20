import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupplierStatementsService } from "./supplier-statements.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

const mockSharpToBuffer = jest.fn();
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: mockSharpToBuffer,
  })),
}));

const duplicateMatch = {
  normalizeNumber: jest.fn((raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, "")),
  findVendorBillDuplicate: jest.fn(),
  findScanDuplicate: jest.fn(),
};

const storage = {
  upload: jest.fn(),
  presignedUrl: jest.fn(),
};

/**
 * `createMockPrisma` predates `SupplierStatementScan`. Graft the model onto
 * the very object `forTenant()` hands back, so a tenant-scoped call and a
 * direct one see the same jest mocks — same trick `vendor-bills.service.spec.ts`
 * uses for `InvoiceScan`.
 */
function graftSupplierStatementScan(prisma: ReturnType<typeof createMockPrisma>) {
  const model = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "scan-1" }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  };
  (prisma as any).supplierStatementScan = model;
  (prisma.forTenant() as any).supplierStatementScan = model;
  return model;
}

describe("SupplierStatementsService", () => {
  let service: SupplierStatementsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let statementScan: ReturnType<typeof graftSupplierStatementScan>;

  const jpegPage = { buffer: Buffer.from("img"), mimeType: "image/jpeg" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    statementScan = graftSupplierStatementScan(prisma);
    duplicateMatch.normalizeNumber.mockClear();
    duplicateMatch.findVendorBillDuplicate.mockReset();
    duplicateMatch.findScanDuplicate.mockReset();
    storage.upload.mockReset();
    storage.upload.mockImplementation((key: string) => Promise.resolve(key));
    storage.presignedUrl.mockReset();
    storage.presignedUrl.mockResolvedValue("https://files.test/scan");
    mockAnthropicCreate.mockReset();
    mockSharpToBuffer.mockReset();
    prisma.supplier.findMany.mockResolvedValue([]);
    prisma.vendorBill.findMany.mockResolvedValue([]);

    // Provide an API key so a fresh scan reaches the Anthropic call.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupplierStatementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: duplicateMatch },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get<SupplierStatementsService>(SupplierStatementsService);
  });

  // ─── missing API key ────────────────────────────────────────────────────────

  it("throws a plain BadRequestException with no `code` when no API key is configured", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupplierStatementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: duplicateMatch },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    const noKeyService = module.get<SupplierStatementsService>(SupplierStatementsService);

    const err = await noKeyService.scanStatement([jpegPage]).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBeUndefined();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  // ─── fileHash short-circuit ─────────────────────────────────────────────────

  it("returns the stored scan for bytes already scanned, without calling the model", async () => {
    statementScan.findFirst.mockResolvedValue({
      id: "scan-earlier",
      status: "SCANNED",
      supplierId: null,
      fileKey: null,
      fileName: "statement.pdf",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      appliedAt: null,
      appliedPaymentGroupId: null,
      extractedPayload: {
        supplier: "Acme Foods",
        openingBalance: 0,
        closingBalance: 0,
        lines: [],
        notes: null,
      },
    });

    const result = await service.scanStatement([jpegPage]);

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(statementScan.create).not.toHaveBeenCalled();
    expect(result.scanId).toBe("scan-earlier");
    expect(result.supplier).toBe("Acme Foods");
    expect(result.matches).toEqual([]);
  });

  // ─── the four typed error codes ─────────────────────────────────────────────

  describe("typed AI error codes", () => {
    it("maps an Anthropic auth failure (401) to AI_KEY_INVALID 400", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 401 });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_KEY_INVALID" }),
      });
    });

    it("maps an Anthropic auth failure (403) to AI_KEY_INVALID 400", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 403 });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_KEY_INVALID" }),
      });
    });

    it("maps a non-transient 4xx (e.g. a rejected/corrupt file) to AI_SCAN_REJECTED 400, not AI_UNAVAILABLE", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 400 });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_SCAN_REJECTED" }),
      });
    });

    it("maps a 429 rate-limit to the retryable AI_UNAVAILABLE, not AI_SCAN_REJECTED", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 429 });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps a 5xx outage to AI_UNAVAILABLE 503", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 529 });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps a network failure with no status to AI_UNAVAILABLE 503", async () => {
      mockAnthropicCreate.mockRejectedValue(new Error("socket hang up"));

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps a non-text response block to AI_PARSE_FAILED 422", async () => {
      mockAnthropicCreate.mockResolvedValue({ content: [{ type: "image" }] });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: expect.objectContaining({ code: "AI_PARSE_FAILED" }),
      });
    });

    it("maps an unparseable AI response to AI_PARSE_FAILED 422", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: "sorry, no JSON here" }],
      });

      await expect(service.scanStatement([jpegPage])).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: expect.objectContaining({ code: "AI_PARSE_FAILED" }),
      });
    });
  });

  // ─── HEIC page handling ─────────────────────────────────────────────────────

  it("skips an unreadable HEIC page and discloses it in notes instead of failing the scan", async () => {
    mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            supplier: "Acme",
            openingBalance: 0,
            closingBalance: 0,
            lines: [],
          }),
        },
      ],
    });

    const result = await service.scanStatement([
      jpegPage,
      { buffer: Buffer.from("heic"), mimeType: "image/heic" },
    ]);

    expect(result.notes).toMatch(/page 2 couldn't be read/i);
    const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === "image")).toHaveLength(1);
  });

  it("rejects when every page is unreadable", async () => {
    mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));

    await expect(
      service.scanStatement([{ buffer: Buffer.from("heic"), mimeType: "image/heic" }]),
    ).rejects.toThrow(/couldn't read any/i);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  // ─── parsing + persistence + matching ───────────────────────────────────────

  describe("a successful scan", () => {
    const fullStatement = {
      supplier: "Acme Foods",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      openingBalance: 0,
      closingBalance: 250,
      lines: [
        {
          date: "2026-07-05",
          kind: "INVOICE",
          refNumber: "INV100",
          amount: 250,
          runningBalance: 250,
        },
      ],
      notes: null,
    };

    const respondWith = (payload: Record<string, unknown>) =>
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      });

    it("persists the scan under the dedicated statement model, distinct from the invoice scanner's", async () => {
      respondWith(fullStatement);

      const result = await service.scanStatement([jpegPage], "user-7");

      const data = statementScan.create.mock.calls[0][0].data;
      expect(data.fileHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.model).toBe("claude-sonnet-5");
      expect(data.scannedById).toBe("user-7");
      expect(data.lineCount).toBe(1);
      expect(data.openingBalance.toString()).toBe("0");
      expect(data.closingBalance.toString()).toBe("250");
      expect(result.scanId).toBe("scan-1");
    });

    it("resolves the supplier and pre-checks an exact-ref, amount-agreeing match", async () => {
      prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
      prisma.vendorBill.findMany.mockResolvedValue([
        {
          id: "bill-1",
          billNumber: "BILL-2026-0001",
          supplierInvoiceNumber: "INV100",
          totalOwed: 250,
          billDate: new Date("2026-07-05T00:00:00.000Z"),
          status: "RECEIVED",
        },
      ]);
      respondWith(fullStatement);

      const result = await service.scanStatement([jpegPage]);

      expect(result.supplierId).toBe("sup-1");
      expect(prisma.vendorBill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { supplierId: "sup-1", status: { not: "VOID" } } }),
      );
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        tier: "EXACT_REF",
        billId: "bill-1",
        preChecked: true,
      });
      expect(duplicateMatch.normalizeNumber).toHaveBeenCalledWith("INV100");
    });

    it("still returns a successful scan when the row cannot be written", async () => {
      respondWith(fullStatement);
      statementScan.create.mockRejectedValue(new Error("db down"));

      const result = await service.scanStatement([jpegPage]);

      expect(result.matches).toHaveLength(1);
      expect(result.scanId).toBeNull();
    });

    it("still returns a successful scan when storage fails", async () => {
      respondWith(fullStatement);
      storage.upload.mockRejectedValue(new Error("disk full"));

      const result = await service.scanStatement([jpegPage]);

      expect(result.scanId).toBe("scan-1");
      expect(statementScan.update).not.toHaveBeenCalled();
    });
  });
});
