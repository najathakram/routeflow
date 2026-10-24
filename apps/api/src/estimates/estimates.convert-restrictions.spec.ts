/**
 * F-05 (#2093, owner rulings 2026-09-25) — `EstimatesService.convertToInvoice` SELLS the estimate's goods,
 * so it asks the selling-restrictions choke point BEFORE a number is reserved or anything is written:
 * a banned product refuses (409 SELLING_RESTRICTED) and burns nothing. The choke point itself is proven in
 * `selling-restrictions.service.spec.ts`; this file pins the CALL: what it is asked, and when.
 */
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

const line = (productId: string | null) => ({
  description: "Widget",
  productId,
  qty: 2,
  unitPrice: 50,
  subtotal: 100,
  boxes: null,
  pieces: null,
  unitLabel: null,
  unitsPerBox: null,
});

describe("EstimatesService.convertToInvoice — selling restrictions (F-05)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const numbering = { reserveNext: jest.fn() };
  const restrictions = { assertLinesSellable: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    numbering.reserveNext.mockRejectedValue(new Error("stop: past the guard"));
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: NumberingService, useValue: numbering },
        { provide: RegulatedLedgerService, useValue: { writeSaleEntries: jest.fn() } },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      status: "ACCEPTED",
      customerId: "cust-1",
      subtotal: 200,
      taxAmount: 0,
      discount: 0,
      total: 200,
      items: [line("p-banned"), line(null), line("p-ok")],
    });
  });

  it("refuses a banned product with 409 SELLING_RESTRICTED before a number is reserved or a row is written", async () => {
    restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
    );
    await expect(service.convertToInvoice("est-1")).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(numbering.reserveNext).not.toHaveBeenCalled();
    expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("asks the choke point for the estimate's customer and product lines as STAFF, ahead of the number reservation", async () => {
    await expect(service.convertToInvoice("est-1")).rejects.toThrow("stop: past the guard");
    expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "test-tenant",
        customerId: "cust-1",
        // a product-less (freeform) line has nothing to check; the two catalog lines are asked about
        // (row 510: each keyed by its source line, "n:<index>" when it has no id)
        lines: [
          { productId: "p-banned", lineKey: "n:0" },
          { productId: "p-ok", lineKey: "n:2" },
        ],
        channel: "STAFF",
        fulfilmentKind: "DELIVERY",
        document: "INVOICE",
      }),
    );
    expect(restrictions.assertLinesSellable.mock.invocationCallOrder[0]).toBeLessThan(
      numbering.reserveNext.mock.invocationCallOrder[0],
    );
  });

  it("L8: at a PICKUP-ONLY tenant this sale is judged as PICKUP (the store's state), not DELIVERY", async () => {
    prisma.tenantFeatureConfig.findFirst.mockResolvedValue({ mode: "pickup" });
    await expect(service.convertToInvoice("est-1")).rejects.toThrow("stop: past the guard");
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilmentKind: "PICKUP" }),
    );
  });

  it("refuses a tenant-less session (403) rather than skipping the check", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(service.convertToInvoice("est-1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
    expect(numbering.reserveNext).not.toHaveBeenCalled();
  });
});
