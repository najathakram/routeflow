import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "./numbering.service";

describe("NumberingService", () => {
  let service: NumberingService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [NumberingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(NumberingService);
  });

  describe("format", () => {
    it("zero-pads to the configured width", () => {
      expect(service.format("INV-", 42, 5)).toBe("INV-00042");
    });
    it("does not truncate numbers longer than the padding", () => {
      expect(service.format("INV-", 123456, 4)).toBe("INV-123456");
    });
    it("padding 0 means no padding", () => {
      expect(service.format("", 7, 0)).toBe("7");
    });
  });

  describe("parseDocumentNumber", () => {
    it("splits prefix, number and padding off the trailing digits", () => {
      expect(service.parseDocumentNumber("INV-08841")).toEqual({
        prefix: "INV-",
        number: 8841,
        padding: 5,
      });
    });
    it("handles a bare number", () => {
      expect(service.parseDocumentNumber("42")).toEqual({ prefix: "", number: 42, padding: 2 });
    });
    it("returns null when there is no trailing number", () => {
      expect(service.parseDocumentNumber("DRAFT")).toBeNull();
    });
  });

  describe("getSettings", () => {
    it("returns all four doc types, defaulting the unconfigured ones", async () => {
      prisma.numberingSequence.findMany.mockResolvedValue([
        { docType: "INVOICE", prefix: "INV-", nextNumber: 8842, padding: 5 },
      ]);
      const settings = await service.getSettings();
      expect(settings.map((s) => s.docType)).toEqual([
        "INVOICE",
        "ESTIMATE",
        "CREDIT_NOTE",
        "PAYMENT",
      ]);
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice).toMatchObject({ preview: "INV-08842", configured: true });
      const estimate = settings.find((s) => s.docType === "ESTIMATE")!;
      expect(estimate).toMatchObject({ preview: "EST-0001", configured: false });
    });
  });

  describe("updateSettings", () => {
    it("upserts the sequence and returns the new preview", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        docType: "INVOICE",
        prefix: "INV-",
        nextNumber: 9000,
        padding: 4,
      });
      const row = await service.updateSettings("INVOICE", { nextNumber: 9000 });
      expect(prisma.numberingSequence.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_docType_year: { tenantId: "test-tenant", docType: "INVOICE", year: 0 },
          },
          update: { nextNumber: 9000 },
        }),
      );
      expect(row.preview).toBe("INV-9000");
    });

    it("throws without a tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.updateSettings("INVOICE", { nextNumber: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("seedFromSource", () => {
    it("continues from the source's last number (INV-08841 → next INV-08842)", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        docType: "INVOICE",
        prefix: "INV-",
        nextNumber: 8842,
        padding: 5,
      });
      const row = await service.seedFromSource("INVOICE", "INV-08841");
      expect(prisma.numberingSequence.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ prefix: "INV-", nextNumber: 8842, padding: 5 }),
        }),
      );
      expect(row.preview).toBe("INV-08842");
    });

    it("rejects a source number it cannot parse", async () => {
      await expect(service.seedFromSource("INVOICE", "n/a")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("reserveNext", () => {
    it("fast path: atomically increments and returns the reserved number", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 5,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 6 });
      const result = await service.reserveNext("INVOICE");
      expect(prisma.numberingSequence.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nextNumber: { increment: 1 } } }),
      );
      expect(result).toEqual({ number: "INV-0005", advanced: false });
    });

    it("collision guard: skips forward past existing numbers and flags advanced", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 10,
      });
      prisma.numberingSequence.findUnique.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 10,
      });
      // INV-0010 already exists (imported), INV-0011 is free.
      const taken = new Set(["INV-0010"]);
      const result = await service.reserveNext("INVOICE", (c) => taken.has(c));
      expect(result).toEqual({ number: "INV-0011", advanced: true });
      expect(prisma.numberingSequence.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nextNumber: 12 } }),
      );
    });

    it("throws (never returns an unverified number) when no free number is found within the cap", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 1,
      });
      prisma.numberingSequence.findUnique.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 1,
      });
      // Pathological predicate: every candidate is "taken".
      await expect(service.reserveNext("INVOICE", () => true)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The sequence must NOT be advanced when it throws.
      expect(prisma.numberingSequence.update).not.toHaveBeenCalled();
    });
  });
});
