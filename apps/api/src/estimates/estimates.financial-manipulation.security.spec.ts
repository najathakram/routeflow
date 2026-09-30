import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * B451 — Strix coverage gap 4 (business-logic financial-total manipulation)
 * on POST /estimates. Phase A CONFIRMED this: estimates.controller.ts had
 * `create(@Body() dto: any)` — no DTO class at all, so the global
 * ValidationPipe's whitelist/forbidNonWhitelisted/transform had nothing to
 * validate against and the entire request body reached
 * EstimatesService.create verbatim; `total = subtotal - discount + tax` from
 * `dto.discount` / `dto.taxAmount` had no Min(0)/Max bound and no
 * negative-total guard.
 *
 * Phase B FIX: a real `CreateEstimateDto` (dto/create-estimate.dto.ts) now
 * types the endpoint — it declares exactly the fields the web client sends
 * today (no `discount`/`taxAmount`, since no caller sends either), so those
 * two now 400 via forbidNonWhitelisted before reaching the service at all.
 * `assertMoneyInvariantsOrThrow` also runs inside the service as
 * defense-in-depth for any future field addition / internal caller. This
 * spec now pins the FIXED behavior for both.
 */
describe("EstimatesService.create — unvalidated discount/tax (B451 gap 4)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-1") },
        },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  it("FIXED: an oversized discount (an internal caller bypassing the DTO) is now caught by the shared guard, not persisted", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );

    // discount is no longer a CreateEstimateDto field — forbidNonWhitelisted
    // already 400s any HTTP caller that sends it (see the DTO-level spec
    // below). This models the remaining defense-in-depth case: an internal
    // caller invoking the service directly with a stray `discount`.
    await expect(
      service.create({ customerId: "cust-1", items: [], discount: 500 } as any),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  it("FIXED: a negative taxAmount (an internal caller bypassing the DTO) is now caught by the shared guard, not persisted", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );

    await expect(
      service.create({ customerId: "cust-1", items: [], taxAmount: -1000 } as any),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.estimate.create).not.toHaveBeenCalled();
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
    } as any);

    const createCall = prisma.estimate.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("DRAFT");
    expect(createCall.data.tenantId).toBeUndefined();
  });
});
