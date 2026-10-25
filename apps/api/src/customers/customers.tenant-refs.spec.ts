import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: any, fn: () => Promise<any>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
}));

const operator: JwtPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: "tenant-a",
  tenantSlug: null,
};
const driver: JwtPayload = { ...operator, role: "DRIVER" };

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// 681 (R5-5) sites 1 and 9: a CustomerPrice row stores the route customer and dto.productId; both must
// resolve inside the caller's tenant before the write, ahead of the family / MSRP policy.
describe("CustomersService.upsertCustomerPrice — tenant refs (681 sites 1, 9)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    prisma.product.findFirst.mockResolvedValue({ id: "prod-a", name: "Acme", kind: "VARIANT" });
    prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-1" });
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
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  it("another tenant's customer on the route is a 404 and nothing is written", async () => {
    const err = await service
      .upsertCustomerPrice("cust-b", { productId: "prod-a", pricingTier: 2 }, operator)
      .catch((e) => e);
    expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
    expect(prisma.customerPrice.delete).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("another tenant's product in the body is a 404 and nothing is written", async () => {
    const err = await service
      .upsertCustomerPrice("cust-a", { productId: "prod-b", pricingTier: 2 }, operator)
      .catch((e) => e);
    expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("the proof runs before the MSRP gate and before the family policy read", async () => {
    const msrpGate = jest.spyOn(service as any, "assertMsrpAllowed").mockResolvedValue(undefined);
    const err = await service
      .upsertCustomerPrice("cust-a", { productId: "prod-b", msrp: 5 }, operator)
      .catch((e) => e);
    expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
    expect(msrpGate).not.toHaveBeenCalled();
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it("the B132 role check still comes first (a driver learns nothing about either id)", async () => {
    const err = await service
      .upsertCustomerPrice("cust-b", { productId: "prod-b", pricingTier: 2 }, driver)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it("control: this tenant's own customer and product take the override", async () => {
    await service.upsertCustomerPrice("cust-a", { productId: "prod-a", pricingTier: 2 }, operator);
    expect(prisma.customerPrice.upsert).toHaveBeenCalledTimes(1);
  });
});
