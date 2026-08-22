import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PlatformPricingService } from "./platform-pricing.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";

/**
 * Unit tests for PlatformPricingService (Platform billing — catalog-driven Stripe
 * prices batch, WP2). Per-tenant custom fee override beats the catalog; when no
 * override is set the tenant's PINNED PlanVersion's PlanDefinition is the source
 * of truth; annual defaults to 10x monthly (2 months free) whenever an explicit
 * annual figure isn't set; an unresolvable price (e.g. ENTERPRISE / isCustom with
 * no override) is a clear BadRequest, never a silent 0/NaN. checkoutPriceData
 * turns the resolution into an inline Stripe `price_data` object in integer cents.
 *
 * Collaborators are mocked at the module boundary (Test.createTestingModule),
 * mirroring payment-requests.service.spec.ts. `resolveTenantPricing` reads the
 * subscription through ONE `tenant.findUnique` with a nested `subscription`
 * select (not a separate `tenantSubscription.findUnique`) — the mock shape here
 * mirrors that.
 */

function makeTenant(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "tenant-1",
    plan: "STARTER",
    planVersionId: "ver-latest",
    subscription: {
      planKey: null as string | null,
      priceOverrideMonthly: null as number | null,
      priceOverrideAnnual: null as number | null,
    },
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<Record<string, any>> = {}) {
  return {
    planKey: "STARTER",
    name: "Starter",
    monthlyPrice: 99,
    annualPrice: null as number | null,
    isCustom: false,
    ...overrides,
  };
}

function makeVersion(definitions: ReturnType<typeof makeDefinition>[], id = "ver-latest") {
  return { id, definitions, addonSkus: [] };
}

describe("PlatformPricingService", () => {
  let service: PlatformPricingService;
  let prisma: { tenant: { findUnique: jest.Mock } };
  let catalog: { getVersionForTenant: jest.Mock };

  beforeEach(async () => {
    prisma = { tenant: { findUnique: jest.fn() } };
    catalog = { getVersionForTenant: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformPricingService,
        { provide: PrismaService, useValue: prisma },
        { provide: PlanCatalogService, useValue: catalog },
      ],
    }).compile();

    service = module.get<PlatformPricingService>(PlatformPricingService);
  });

  // ─── resolveTenantPricing ───────────────────────────────────────────────────

  describe("resolveTenantPricing", () => {
    it("resolves from the catalog when no override is set, with annual falling back to 10x monthly", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "STARTER",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "STARTER", name: "Starter", monthlyPrice: 99 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      expect(result).toMatchObject({
        planKey: "STARTER",
        monthly: 99,
        annual: 990, // 99 * 10 — annualPrice unset in the catalog
        source: "catalog",
        currency: "usd",
      });
      // The tenant's PINNED version, not just "the latest" — proves grandfathered
      // tenants aren't silently upgraded to a newer version's numbers.
      expect(catalog.getVersionForTenant).toHaveBeenCalledWith("ver-latest");
    });

    it("uses the catalog's explicit annualPrice instead of the 10x fallback when set", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "GROWTH",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([
          makeDefinition({
            planKey: "GROWTH",
            name: "Growth",
            monthlyPrice: 249,
            annualPrice: 2000,
          }),
        ]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      expect(result.monthly).toBe(249);
      expect(result.annual).toBe(2000);
      expect(result.source).toBe("catalog");
    });

    it("a per-tenant custom fee override beats the catalog price entirely", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: { planKey: "GROWTH", priceOverrideMonthly: 150, priceOverrideAnnual: null },
        }),
      );
      // Catalog says 249 — must be ignored once an override is present.
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      expect(result.monthly).toBe(150);
      expect(result.annual).toBe(1500); // override annual unset → 10x the override monthly
      expect(result.source).toBe("override");
    });

    it("an explicit annual override wins over the 10x-monthly fallback", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: { planKey: "GROWTH", priceOverrideMonthly: 150, priceOverrideAnnual: 1400 },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      expect(result.monthly).toBe(150);
      expect(result.annual).toBe(1400); // NOT 1500 — explicit override annual wins
      expect(result.source).toBe("override");
    });

    it("throws BadRequest for an unresolvable price — isCustom plan, no override set", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          plan: "ENTERPRISE",
          subscription: {
            planKey: "ENTERPRISE",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([
          makeDefinition({
            planKey: "ENTERPRISE",
            name: "Enterprise",
            monthlyPrice: null,
            annualPrice: null,
            isCustom: true,
          }),
        ]),
      );

      await expect(service.resolveTenantPricing("tenant-1")).rejects.toThrow(BadRequestException);
    });

    it("honours an ANNUAL-ONLY override (monthly still from the catalog) instead of silently ignoring it", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "GROWTH",
            priceOverrideMonthly: null,
            priceOverrideAnnual: 1800,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      // Was: annual silently resolved to 249 * 10 = 2490 — a 1.4x overcharge on a
      // negotiated annual prepay the admin had already saved.
      expect(result.annual).toBe(1800);
      expect(result.monthly).toBe(249);
      expect(result.source).toBe("override");
    });

    it("throws BadRequest when only an annual override is set on a plan with no catalog monthly price", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          plan: "ENTERPRISE",
          subscription: {
            planKey: "ENTERPRISE",
            priceOverrideMonthly: null,
            priceOverrideAnnual: 1800,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([
          makeDefinition({ planKey: "ENTERPRISE", monthlyPrice: null, isCustom: true }),
        ]),
      );

      await expect(service.resolveTenantPricing("tenant-1")).rejects.toThrow(BadRequestException);
    });

    it("treats a catalog annualPrice of 0 as a real (promotional) price, not as 'unset'", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "STARTER",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "STARTER", monthlyPrice: 99, annualPrice: 0 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      // `Number(0) || monthly * 10` would charge 990 for a free-first-year promo.
      expect(result.annual).toBe(0);
    });

    it("falls back to the tenant's legacy `plan` enum when it has no TenantSubscription row yet", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({ plan: "BUSINESS", subscription: null }), // legacy alias → SCALE
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "SCALE", name: "Scale", monthlyPrice: 499 })]),
      );

      const result = await service.resolveTenantPricing("tenant-1");

      expect(result.planKey).toBe("SCALE");
      expect(result.monthly).toBe(499);
    });
  });

  // ─── resolveCatalogPricing ──────────────────────────────────────────────────

  describe("resolveCatalogPricing", () => {
    it("ignores the override and prices from the catalog (the 'can this tenant be cleared?' check)", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: { planKey: "GROWTH", priceOverrideMonthly: 150, priceOverrideAnnual: 1400 },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 })]),
      );

      const result = await service.resolveCatalogPricing("tenant-1");

      expect(result.monthly).toBe(249);
      expect(result.source).toBe("catalog");
    });

    it("throws BadRequest for an isCustom plan — so clearing its custom fee is rejected BEFORE the write", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          plan: "ENTERPRISE",
          subscription: {
            planKey: "ENTERPRISE",
            priceOverrideMonthly: 1200,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([
          makeDefinition({ planKey: "ENTERPRISE", monthlyPrice: null, isCustom: true }),
        ]),
      );

      await expect(service.resolveCatalogPricing("tenant-1")).rejects.toThrow(BadRequestException);
    });
  });

  // ─── checkoutPriceData ──────────────────────────────────────────────────────

  describe("checkoutPriceData", () => {
    it("builds a monthly price_data object with integer cents (99 → 9900) and recurring.interval", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "STARTER",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "STARTER", name: "Starter", monthlyPrice: 99 })]),
      );

      const priceData = await service.checkoutPriceData("tenant-1", "month");

      expect(priceData).toMatchObject({
        currency: "usd",
        unit_amount: 9900,
        recurring: { interval: "month" },
      });
      expect(priceData.product_data?.name).toContain("Starter");
    });

    it("builds an annual price_data object using the 10x-monthly fallback in integer cents (249 → 249000)", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          subscription: {
            planKey: "GROWTH",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([makeDefinition({ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 })]),
      );

      const priceData = await service.checkoutPriceData("tenant-1", "year");

      expect(priceData).toMatchObject({
        currency: "usd",
        unit_amount: 249000, // (249 * 10) * 100
        recurring: { interval: "year" },
      });
    });

    it("propagates the unresolvable-price BadRequest instead of building a $0 checkout", async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        makeTenant({
          plan: "ENTERPRISE",
          subscription: {
            planKey: "ENTERPRISE",
            priceOverrideMonthly: null,
            priceOverrideAnnual: null,
          },
        }),
      );
      catalog.getVersionForTenant.mockResolvedValue(
        makeVersion([
          makeDefinition({
            planKey: "ENTERPRISE",
            name: "Enterprise",
            monthlyPrice: null,
            annualPrice: null,
            isCustom: true,
          }),
        ]),
      );

      await expect(service.checkoutPriceData("tenant-1", "month")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
