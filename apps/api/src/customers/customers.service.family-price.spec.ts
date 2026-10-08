import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Same stand-in as customers.service.spec.ts: a real advisory lock needs a live DB connection,
// which is out of scope for a unit test — this reproduces just the property
// applyAdvancePaymentToInvoice's lock depends on (mutual exclusion by key), nothing more.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: any, fn: () => Promise<any>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
}));

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

// B1216: split into its own file rather than grown inline — customers.service.spec.ts is already at
// its size-ratchet ceiling (see common/size-ratchet.spec.ts).
describe("CustomersService — upsertCustomerPrice refuses a FAMILY (B1216)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncInvoiceCommission: jest.fn() },
        },
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  it("a FAMILY container cannot carry a price override (coded 400, nothing written)", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "fam", name: "Acme Soda", kind: "FAMILY" });
    const err = await service
      .upsertCustomerPrice("cust-1", { productId: "fam", pricingTier: 3 }, operatorPayload)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "FAMILY_NOT_PRICEABLE",
      productIds: ["fam"],
    });
    expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
  });

  it("a VARIANT or standalone product still takes a price override", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "v1", name: "Cherry", kind: "VARIANT" });
    prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-9" });
    await service.upsertCustomerPrice(
      "cust-1",
      { productId: "v1", pricingTier: 3 },
      operatorPayload,
    );
    expect(prisma.customerPrice.upsert).toHaveBeenCalledTimes(1);
  });

  it("clearing a legacy override on a FAMILY stays possible", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "fam", name: "Acme Soda", kind: "FAMILY" });
    prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: null });
    prisma.customerPrice.delete.mockResolvedValue({ id: "cp-1" });
    const result = await service.upsertCustomerPrice(
      "cust-1",
      { productId: "fam", pricingTier: null },
      operatorPayload,
    );
    expect(result).toBeNull();
    expect(prisma.customerPrice.delete).toHaveBeenCalled();
  });
});
