import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

// A unit test has no live Postgres: run the advisory-lock critical section directly.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: unknown, fn: () => Promise<unknown>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

describe("CustomersService.updateAddress — coordinates survive an update that changes no location field", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
  const ADDRESS = { label: "Main", line1: "1 Congress Ave", city: "Austin", zip: "78701" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const module = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } }, // no geocoder key
        { provide: StorageService, useValue: {} },
        {
          provide: MeterService,
          useValue: { read: jest.fn().mockResolvedValue({ included: null, used: 0 }) },
        },
        {
          provide: PlanCatalogService,
          useValue: { getPublishedVersion: jest.fn().mockResolvedValue(null) },
        },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue({}) } },
        { provide: CommissionEngineService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = module.get(CustomersService);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
  });

  const STORED = {
    line1: "1 Congress Ave",
    line2: null,
    city: "Austin",
    state: "Texas",
    zip: "78701",
    stateCode: "TX",
  };
  let geocode: jest.SpyInstance;
  const edit = (dto: Record<string, unknown>) =>
    service.updateAddress("cust-1", "addr-1", dto as any);
  const written = () => prisma.customerAddress.update.mock.calls[0][0].data;

  beforeEach(() => {
    prisma.customerAddress.findFirst.mockResolvedValue(STORED);
    prisma.customerAddress.update.mockResolvedValue({ id: "addr-1", customerId: "cust-1" });
    geocode = jest.spyOn(service as any, "geocodeIfPossible").mockResolvedValue(null);
  });

  it("an isDefault-only update keeps lat/lng and does not geocode", async () => {
    await edit({ isDefault: true });
    expect(written()).not.toHaveProperty("lat");
    expect(written()).not.toHaveProperty("lng");
    expect(geocode).not.toHaveBeenCalled();
  });

  it("a non-location change (label, addressType) keeps lat/lng and does not geocode", async () => {
    await edit({ label: "Dock", addressType: "SHIPPING" });
    expect(written()).not.toHaveProperty("lat");
    expect(geocode).not.toHaveBeenCalled();
  });

  it("a city change nulls lat/lng and re-geocodes", async () => {
    await edit({ city: "Dallas" });
    expect(written()).toMatchObject({ lat: null, lng: null });
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it.each([["line1"], ["line2"], ["state"], ["zip"]])(
    "a %s change nulls lat/lng and re-geocodes",
    async (field) => {
      await edit({ [field]: "changed" });
      expect(written()).toMatchObject({ lat: null, lng: null });
      expect(geocode).toHaveBeenCalledTimes(1);
    },
  );

  it("location fields resent with their stored values count as no change", async () => {
    await edit({
      line1: "1 Congress Ave",
      city: "Austin",
      state: "Texas",
      zip: "78701",
      isDefault: true,
    });
    expect(written()).not.toHaveProperty("lat");
    expect(geocode).not.toHaveBeenCalled();
  });

  it("a blank line2 resent for a stored null counts as no change", async () => {
    await edit({ line2: "", isDefault: true });
    expect(written()).not.toHaveProperty("lat");
    expect(geocode).not.toHaveBeenCalled();
  });
});
