import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B451 Phase A — Strix coverage gap 4 (business-logic financial-total
 * manipulation) on POST /estimates. estimates.controller.ts:20 declares
 * `create(@Body() dto: any)` — no DTO class at all, so the global
 * ValidationPipe's whitelist/forbidNonWhitelisted/transform has nothing to
 * validate against and the entire request body reaches EstimatesService.create
 * verbatim. estimates.service.ts:88-201 then computes
 * `total = subtotal - discount + tax` from `dto.discount` / `dto.taxAmount`
 * with NO Min(0)/Max bound anywhere and no negative-total guard (contrast
 * invoices.service.ts:469-502, which has both).
 */
describe("EstimatesService.create — unvalidated discount/tax (B451 gap 4)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-1") },
        },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  it("CONFIRMED: an oversized discount with no source items drives the persisted total negative", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );

    // No items → subtotal is 0. `discount` has no DTO (no class exists) and no
    // service-side bound, so any client-supplied number reaches the create() call.
    await service.create({ customerId: "cust-1", items: [], discount: 500 });

    const createCall = prisma.estimate.create.mock.calls[0][0];
    expect(createCall.data.discount).toBe(500);
    expect(createCall.data.total).toBeLessThan(0);
  });

  it("CONFIRMED: a negative taxAmount is accepted verbatim (no Min(0) anywhere on this path)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );

    await service.create({ customerId: "cust-1", items: [], taxAmount: -1000 });

    const createCall = prisma.estimate.create.mock.calls[0][0];
    expect(createCall.data.taxAmount).toBe(-1000);
    expect(createCall.data.total).toBeLessThan(0);
  });

  it("REFUTED (mass assignment): tenantId and status are server-derived, never read from dto", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );

    await service.create({
      customerId: "cust-1",
      items: [],
      tenantId: "attacker-tenant",
      status: "ACCEPTED",
    });

    const createCall = prisma.estimate.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("DRAFT");
    expect(createCall.data.tenantId).toBeUndefined();
  });
});
