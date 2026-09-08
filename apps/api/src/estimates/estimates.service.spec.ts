import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

// B8: accept() had no status guard and convertToInvoice() was a read-then-write
// with no transaction, so a double-click (re-accept a CONVERTED estimate, or two
// concurrent converts) could mint a second invoice for the same estimate. Both
// paths now claim their status transition atomically via a conditional
// updateMany before doing any invoice work.
describe("EstimatesService — B8 accept/convert duplicate-invoice race", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  // B100/F16b harness note: convertToInvoice routes its mint through
  // NumberingService once P1/P2 land — EstimatesService does not inject it yet, so
  // this provider is unused by today's code and only backs the new REG-B100/pin
  // tests below (cause-ruling.md §2 D3). Default resolves to the same
  // "INV-2026-0001" the pre-B100 findFirst-null mock produced.
  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockNumbering.reserveNext.mockClear();
    mockNumbering.reserveNext.mockResolvedValue("INV-2026-0001");
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        // flag.msrp defaults OFF so convertToInvoice's MSRP snapshot is a no-op.
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  describe("accept()", () => {
    it("throws and does not flip status when the estimate is already CONVERTED", async () => {
      // The atomic claim excludes CONVERTED in its WHERE, so a re-accept
      // attempt matches zero rows.
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.accept("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.accept("est-1")).rejects.toThrow(
        "Converted estimates cannot be re-accepted",
      );

      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: { not: "CONVERTED" } },
        data: { status: "ACCEPTED" },
      });
      // A losing claim must never fall through to the final read/return.
      expect(prisma.estimate.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("claims the status and returns the updated estimate when not CONVERTED", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUniqueOrThrow.mockResolvedValue({ id: "est-1", status: "ACCEPTED" });

      const result = await service.accept("est-1");

      expect(result).toEqual({ id: "est-1", status: "ACCEPTED" });
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: { not: "CONVERTED" } },
        data: { status: "ACCEPTED" },
      });
    });
  });

  describe("convertToInvoice()", () => {
    it("throws and creates no invoice when a concurrent convert already won the claim", async () => {
      // Simulates the losing side of a race: another request's claim already
      // flipped ACCEPTED -> CONVERTED first, so this updateMany matches nothing.
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findUnique.mockResolvedValue({ id: "est-1", status: "ACCEPTED" });

      await expect(service.convertToInvoice("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(
        "Only ACCEPTED estimates can be converted",
      );

      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: "ACCEPTED" },
        data: { status: "CONVERTED" },
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("claims the status before creating the invoice, and mints exactly one invoice", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-1",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 100,
        taxAmount: 10,
        discount: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [
          {
            description: "Widget",
            productId: "prod-1",
            qty: 2,
            unitPrice: 50,
            subtotal: 100,
          },
        ],
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-1", ...args.data, customer: {} }),
      );

      const inv = await service.convertToInvoice("est-1");

      expect(inv).toMatchObject({ id: "inv-1", customerId: "cust-1", status: "DRAFT" });
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: "ACCEPTED" },
        data: { status: "CONVERTED" },
      });

      // The claim must land strictly before the invoice is created — that
      // ordering is what makes the claim atomic protection instead of decoration.
      const claimOrder = prisma.estimate.updateMany.mock.invocationCallOrder[0];
      const createOrder = prisma.invoice.create.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(createOrder);
    });

    // REG-B100-F (cause-ruling.md §3, cause-refutation.md §7.4): convertToInvoice
    // has no P2002 catch today — a concurrent convert's unique-constraint hit
    // propagates as a raw 500. TODAY this rejects with the plain `{ code: "P2002" }`
    // object, not a ConflictException, so the assertion below fails on the type.
    it("REG-B100-F: maps a concurrent convert's P2002 into ConflictException (409), not a raw 500", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-2",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 100,
        taxAmount: 10,
        discount: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [],
      });
      prisma.invoice.create.mockRejectedValue({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`invoiceNumber`)",
      });

      await expect(service.convertToInvoice("est-2")).rejects.toBeInstanceOf(ConflictException);
    });

    // B100/F16b pin (P5, cause-ruling.md §2 D3): convertToInvoice calls
    // numbering.reserveNext("INVOICE", { year, tx }) directly — it has no
    // generateInvoiceNumber helper of its own. TODAY it scans tx.invoice.findFirst
    // instead and never touches NumberingService, so this fails on "was not
    // called".
    it("REG-B100 pin P5: delegates to numbering.reserveNext before the tx instead of scanning tx.invoice.findFirst", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-3",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 10,
        taxAmount: 1,
        discount: 0,
        total: 11,
        notes: null,
        terms: null,
        items: [],
      });
      mockNumbering.reserveNext.mockResolvedValueOnce("INV-2026-0038");
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-9", ...args.data, customer: {} }),
      );

      const inv = await service.convertToInvoice("est-3");

      expect(mockNumbering.reserveNext).toHaveBeenCalledWith(
        "INVOICE",
        expect.objectContaining({ year: new Date().getFullYear() }),
      );
      expect((inv as any).invoiceNumber).toBe("INV-2026-0038");
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });
  });
});
