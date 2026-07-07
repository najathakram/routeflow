import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { DuplicateMatchService } from "./duplicate-match.service";

describe("DuplicateMatchService", () => {
  let service: DuplicateMatchService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [DuplicateMatchService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DuplicateMatchService);
  });

  describe("normalizeNumber", () => {
    it("strips whitespace and uppercases", () => {
      expect(service.normalizeNumber("inv 088 41")).toBe("INV08841");
    });
  });

  describe("findInvoiceDuplicate", () => {
    it("matches a same-number candidate within the date/total window", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-a", invoiceNumber: "INV-08841" },
        { id: "inv-b", invoiceNumber: "OTHER-1" },
      ]);
      const match = await service.findInvoiceDuplicate({
        number: "inv-08841",
        total: 2202.04,
        issueDate: new Date("2026-07-01"),
      });
      expect(match).toEqual({ id: "inv-a", invoiceNumber: "INV-08841" });
    });

    it("queries a ±1 day window and total-to-the-cent range", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      await service.findInvoiceDuplicate({
        number: "X",
        total: 100,
        issueDate: new Date("2026-07-10T12:00:00Z"),
      });
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.total).toEqual({ gte: 100 - 0.005, lte: 100 + 0.005 });
      expect(where.issueDate.gte).toEqual(new Date("2026-07-09T12:00:00Z"));
      expect(where.issueDate.lte).toEqual(new Date("2026-07-11T12:00:00Z"));
    });

    it("returns null when no candidate shares the number", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ id: "x", invoiceNumber: "DIFFERENT" }]);
      await expect(
        service.findInvoiceDuplicate({ number: "INV-1", total: 5, issueDate: new Date() }),
      ).resolves.toBeNull();
    });

    it("matches on total+date alone when no number is supplied", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ id: "y", invoiceNumber: "ANY" }]);
      await expect(
        service.findInvoiceDuplicate({ total: 5, issueDate: new Date() }),
      ).resolves.toEqual({ id: "y", invoiceNumber: "ANY" });
    });
  });
});
