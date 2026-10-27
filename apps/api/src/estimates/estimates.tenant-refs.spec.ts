import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// 681 (R5-5) site 4: an estimate stores its customer and every item's productId. Both must resolve inside the
// caller's tenant before the write, the same 404 as a missing id. (The pre-existing customer 404 below is
// reached through forTenant().findUnique; the helper proof is what the writers inventory pins.)
describe("EstimatesService.create — tenant refs (681 site 4)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const create = (customerId: string, productId?: string) =>
    service.create({
      customerId,
      items: [{ description: "Line", productId, unitPrice: 10, qty: 1 }],
    } as never);

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    // A row the customer read finds for any id: isolates the product proof as the only thing that can refuse.
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-a",
      pricingTier: 1,
      isTaxExempt: false,
    });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-2026-0001") },
        },
        { provide: RegulatedLedgerService, useValue: { writeSaleEntries: jest.fn() } },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  it("another tenant's product on an item is a 404 and no estimate is written", async () => {
    const err = await create("cust-a", "prod-b").catch((e) => e);
    expect(prisma.estimate.create).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("Product not found");
  });

  it("another tenant's customer is a 404 and no estimate is written", async () => {
    const err = await create("cust-b", "prod-a").catch((e) => e);
    expect(prisma.estimate.create).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("Customer not found");
  });

  it("control: this tenant's customer and product write the estimate", async () => {
    await create("cust-a", "prod-a");
    expect(prisma.estimate.create).toHaveBeenCalledTimes(1);
  });

  it("a freeform item (no product) needs no product proof", async () => {
    await create("cust-a", undefined);
    expect(prisma.estimate.create).toHaveBeenCalledTimes(1);
  });
});
