import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

// B8: accept() had no status guard and convertToInvoice() was a read-then-write
// with no transaction, so a double-click (re-accept a CONVERTED estimate, or two
// concurrent converts) could mint a second invoice for the same estimate. Both
// paths now claim their status transition atomically via a conditional
// updateMany before doing any invoice work.
describe("EstimatesService — B8 accept/convert duplicate-invoice race", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        // flag.msrp defaults OFF so convertToInvoice's MSRP snapshot is a no-op.
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
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
      prisma.invoice.findFirst.mockResolvedValue(null); // nextInvoiceNumber -> INV-…-0001
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
  });
});
