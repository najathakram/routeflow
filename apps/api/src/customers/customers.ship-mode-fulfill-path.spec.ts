/**
 * A tenant whose effective `fulfilment_model` feature mode is "ship" creates customers with
 * fulfillPath SHIP when the client sent none; any other mode keeps today's ROUTE, a client-sent
 * value always wins, and a failed mode read fails open to ROUTE. Harness copied from
 * `customers.service.person-name.spec.ts`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("CustomersService.create — ship-mode default fulfilment path", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let featureConfig: { getEffectiveMode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // Default = the mode is not registered yet ("unset"): today's ROUTE behaviour.
    featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("unset") };
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        {
          provide: MeterService,
          useValue: {
            read: jest.fn().mockResolvedValue({
              meter: "CUSTOMERS",
              used: 0,
              included: null,
              remaining: null,
              resetsAt: null,
            }),
          },
        },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: FeatureConfigService, useValue: featureConfig },
      ],
    }).compile();

    service = module.get(CustomersService);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
    prisma.customer.create.mockResolvedValue({ id: "c1" });
  });

  const baseDto = { username: "acme", businessName: "Acme", contactName: "Jane" } as any;
  const writtenPath = () => prisma.customer.create.mock.calls[0][0].data.fulfillPath;
  const setMode = (mode: string) => featureConfig.getEffectiveMode.mockResolvedValue(mode);

  it.each(["unset", "delivery", "both", "pickup"])(
    "mode %s, nothing sent: ROUTE exactly as today",
    async (mode) => {
      setMode(mode);
      await service.create({ ...baseDto });
      expect(writtenPath()).toBe("ROUTE");
    },
  );

  it("ship mode, nothing sent: SHIP, from one fulfilment_model read", async () => {
    setMode("ship");
    await service.create({ ...baseDto });
    expect(writtenPath()).toBe("SHIP");
    expect(featureConfig.getEffectiveMode).toHaveBeenCalledTimes(1);
    expect(featureConfig.getEffectiveMode).toHaveBeenCalledWith("test-tenant", "fulfilment_model");
  });

  it("ship mode but the client sent ROUTE: ROUTE (the client wins), no mode read", async () => {
    setMode("ship");
    await service.create({ ...baseDto, fulfillPath: "ROUTE" });
    expect(writtenPath()).toBe("ROUTE");
    expect(featureConfig.getEffectiveMode).not.toHaveBeenCalled();
  });

  it("a non-ship tenant that sent SHIP gets SHIP", async () => {
    await service.create({ ...baseDto, fulfillPath: "SHIP" });
    expect(writtenPath()).toBe("SHIP");
  });

  it("the mode read throws: ROUTE as today, the customer still saves", async () => {
    featureConfig.getEffectiveMode.mockRejectedValue(new Error("db down"));
    await expect(service.create({ ...baseDto })).resolves.toBeDefined();
    expect(writtenPath()).toBe("ROUTE");
  });
});
