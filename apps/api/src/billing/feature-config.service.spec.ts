import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigStore } from "./feature-config.store";
import { FeatureConfigService } from "./feature-config.service";

/**
 * Feature grants v2 brief C (PR-4), oracle 3 — FeatureConfigService.set/clear/getState against
 * `routes_dispatch` (`scheduled` requires `recurring_routes`; `adhoc` requires `order_delivery`).
 */
describe("FeatureConfigService", () => {
  let service: FeatureConfigService;
  let prisma: {
    tenantFeatureConfig: { upsert: jest.Mock; deleteMany: jest.Mock };
    tenant: { findUnique: jest.Mock };
  };
  let store: { getMode: jest.Mock; invalidate: jest.Mock };
  let audit: { log: jest.Mock };
  let addons: { hasAddon: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let overrides: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tenantFeatureConfig: { upsert: jest.fn(), deleteMany: jest.fn() },
      // Fix round 1 (Opus review, item 4): set() checks the tenant exists before writing.
      tenant: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) => Promise.resolve({ id: where.id })),
      },
    };
    store = { getMode: jest.fn(), invalidate: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    addons = { hasAddon: jest.fn() };
    entitlements = { hasFlag: jest.fn() };
    // Fix round 1 (Opus review, item 2): no active override by default — every existing test
    // below falls through to the addon/plan-flag check exactly as before this was added.
    overrides = { get: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: FeatureConfigStore, useValue: store },
        { provide: AuditService, useValue: audit },
        { provide: AddonService, useValue: addons },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: FeatureOverrideService, useValue: overrides },
      ],
    }).compile();

    service = module.get(FeatureConfigService);
  });

  describe("set", () => {
    it("PUT routes_dispatch=scheduled without recurring_routes -> 409 naming it", async () => {
      addons.hasAddon.mockResolvedValue(false);

      await expect(
        service.set("tenant-a", "routes_dispatch", "scheduled", "trying it out", "admin-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          key: "routes_dispatch",
          mode: "scheduled",
          missing: "recurring_routes",
        }),
      });
      expect(prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    });

    it("409 is a ConflictException", async () => {
      addons.hasAddon.mockResolvedValue(false);
      await expect(
        service.set("tenant-a", "routes_dispatch", "scheduled", "r", "admin-1"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("GRANT recurring_routes then PUT scheduled -> 200 (writes the row, audits, invalidates cache)", async () => {
      addons.hasAddon.mockResolvedValue(true);
      prisma.tenantFeatureConfig.upsert.mockResolvedValue({});

      await service.set("tenant-a", "routes_dispatch", "scheduled", "pilot", "admin-1");

      expect(prisma.tenantFeatureConfig.upsert).toHaveBeenCalledWith({
        where: { tenantId_featureKey: { tenantId: "tenant-a", featureKey: "routes_dispatch" } },
        create: {
          tenantId: "tenant-a",
          featureKey: "routes_dispatch",
          mode: "scheduled",
          reason: "pilot",
          updatedById: "admin-1",
        },
        update: { mode: "scheduled", reason: "pilot", updatedById: "admin-1" },
      });
      expect(store.invalidate).toHaveBeenCalledWith("tenant-a", "routes_dispatch");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "FEATURE_CONFIG_SET", tenantId: "tenant-a" }),
      );
    });

    it("an unknown mode -> 400 BadRequestException, never writes", async () => {
      await expect(
        service.set("tenant-a", "routes_dispatch", "not_a_real_mode", "r", "admin-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    });

    it("an unknown key -> 400 BadRequestException", async () => {
      await expect(
        service.set("tenant-a", "not_a_real_key", "scheduled", "r", "admin-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("mixed requires BOTH recurring_routes and order_delivery — missing the second still 409s naming it", async () => {
      addons.hasAddon.mockImplementation((_tenantId: string, key: string) =>
        Promise.resolve(key === "recurring_routes"),
      );

      await expect(
        service.set("tenant-a", "routes_dispatch", "mixed", "r", "admin-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ missing: "order_delivery" }),
      });
    });

    it("tenant B's PUT never touches tenant A's row (where is always {tenantId, featureKey} together)", async () => {
      addons.hasAddon.mockResolvedValue(true);
      prisma.tenantFeatureConfig.upsert.mockResolvedValue({});

      await service.set("tenant-b", "routes_dispatch", "scheduled", "r", "admin-2");

      const call = prisma.tenantFeatureConfig.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        tenantId_featureKey: { tenantId: "tenant-b", featureKey: "routes_dispatch" },
      });
      expect(call.where.tenantId_featureKey.tenantId).not.toBe("tenant-a");
    });

    // Fix round 1 (Opus review, item 2) — #795 overrides must be honoured the same way
    // AddonGuard/EntitlementsService.hasFlag already do, until brief A's real can() lands.
    it("a GRANT override on recurring_routes satisfies requires.allOf even without the addon held", async () => {
      addons.hasAddon.mockResolvedValue(false); // addon NOT held
      overrides.get.mockImplementation((_tenantId: string, key: string) =>
        Promise.resolve(key === "recurring_routes" ? "GRANT" : null),
      );
      prisma.tenantFeatureConfig.upsert.mockResolvedValue({});

      await expect(
        service.set("tenant-a", "routes_dispatch", "scheduled", "override pilot", "admin-1"),
      ).resolves.toBeUndefined();
      expect(prisma.tenantFeatureConfig.upsert).toHaveBeenCalled();
    });

    it("a DENY override on recurring_routes blocks requires.allOf even with the addon held", async () => {
      addons.hasAddon.mockResolvedValue(true); // addon IS held
      overrides.get.mockImplementation((_tenantId: string, key: string) =>
        Promise.resolve(key === "recurring_routes" ? "DENY" : null),
      );

      await expect(
        service.set("tenant-a", "routes_dispatch", "scheduled", "r", "admin-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ missing: "recurring_routes" }),
      });
      expect(prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    });

    // Fix round 1 (Opus review, item 4) — LOW items: an unavailable mode and an unknown tenant.
    it("a mode marked unavailable in the registry -> 400, never writes (catalog_varieties' single_sku)", async () => {
      await expect(
        service.set("tenant-a", "catalog_varieties", "single_sku", "r", "admin-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    });

    it("an unknown tenant id -> clean 404, never an FK 500", async () => {
      addons.hasAddon.mockResolvedValue(true);
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(
        service.set("nonexistent-tenant", "routes_dispatch", "scheduled", "r", "admin-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("DELETE reverts to default: deleteMany scoped to {tenantId, featureKey}, invalidates cache, audits", async () => {
      prisma.tenantFeatureConfig.deleteMany.mockResolvedValue({ count: 1 });

      await service.clear("tenant-a", "routes_dispatch", "revert", "admin-1");

      expect(prisma.tenantFeatureConfig.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-a", featureKey: "routes_dispatch" },
      });
      expect(store.invalidate).toHaveBeenCalledWith("tenant-a", "routes_dispatch");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "FEATURE_CONFIG_CLEARED", tenantId: "tenant-a" }),
      );
    });

    it("clearing a key with no config -> 400", async () => {
      await expect(
        service.clear("tenant-a", "not_a_real_key", "r", "admin-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("getState", () => {
    it("unset (no row, no grants) — mixed/scheduled/adhoc are all blocked, unset is allowed", async () => {
      store.getMode.mockResolvedValue({ value: "unset", source: "REGISTRY_DEFAULT" });
      addons.hasAddon.mockResolvedValue(false);

      const state = await service.getState("tenant-a", "routes_dispatch");

      expect(state.value).toBe("unset");
      expect(state.effective).toBe("unset");
      expect(state.source).toBe("REGISTRY_DEFAULT");
      expect(state.allowed).toEqual(["unset"]);
      expect(state.blocked.sort()).toEqual(["adhoc", "mixed", "scheduled"]);
    });

    it("holding both addons allows every mode", async () => {
      store.getMode.mockResolvedValue({ value: "mixed", source: "TENANT" });
      addons.hasAddon.mockResolvedValue(true);

      const state = await service.getState("tenant-a", "routes_dispatch");

      expect(state.allowed.sort()).toEqual(["adhoc", "mixed", "scheduled", "unset"]);
      expect(state.blocked).toEqual([]);
    });

    // Fix round 1 (Opus review, item 1) — stored != effective once the tenant no longer
    // qualifies for the stored mode.
    it("stored 'scheduled' but recurring_routes no longer held -> value stays 'scheduled', effective falls back to 'unset'", async () => {
      store.getMode.mockResolvedValue({ value: "scheduled", source: "TENANT" });
      addons.hasAddon.mockResolvedValue(false);

      const state = await service.getState("tenant-a", "routes_dispatch");

      expect(state.value).toBe("scheduled");
      expect(state.effective).toBe("unset");
      expect(state.source).toBe("TENANT");
    });
  });

  describe("getEffectiveMode", () => {
    it("returns the stored value when its requires.allOf is still held", async () => {
      store.getMode.mockResolvedValue({ value: "scheduled", source: "TENANT" });
      addons.hasAddon.mockResolvedValue(true);

      await expect(service.getEffectiveMode("tenant-a", "routes_dispatch")).resolves.toBe(
        "scheduled",
      );
    });

    // The exact case named in the Opus review: a tenant set to "scheduled" who lost
    // recurring_routes can still dispatch ADHOC — because THIS is what RoutesService.createRun
    // gates on, not the raw stored value (routes.service.spec.ts proves the wiring end to end).
    it("a tenant stored as 'scheduled' who no longer holds recurring_routes resolves to the fallback 'unset'", async () => {
      store.getMode.mockResolvedValue({ value: "scheduled", source: "TENANT" });
      addons.hasAddon.mockResolvedValue(false);

      await expect(service.getEffectiveMode("tenant-a", "routes_dispatch")).resolves.toBe("unset");
    });

    it("a DENY override on the stored mode's required key also falls back, even with the addon held", async () => {
      store.getMode.mockResolvedValue({ value: "adhoc", source: "TENANT" });
      addons.hasAddon.mockResolvedValue(true);
      overrides.get.mockImplementation((_tenantId: string, key: string) =>
        Promise.resolve(key === "order_delivery" ? "DENY" : null),
      );

      await expect(service.getEffectiveMode("tenant-a", "routes_dispatch")).resolves.toBe("unset");
    });

    it("returns the registry fallback for a key with no config block", async () => {
      await expect(service.getEffectiveMode("tenant-a", "ocr")).resolves.toBe("unset");
    });
  });
});
