import { Test } from "@nestjs/testing";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { AddonService } from "../billing/addon.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * #2717 M2 (SA-574) family price authority. Test 15: the `mixed_packs` registry row is OFF by
 * default, and a tenant with no config row resolves to "off" through the real FeatureConfigService.
 */
describe("mixed_packs registry row (test 15)", () => {
  const row = FEATURE_REGISTRY.find((f) => f.key === "mixed_packs");

  it("exists, boolean, catalog area, not default-granted", () => {
    expect(row).toBeDefined();
    expect(row?.kind).toBe("boolean");
    expect(row?.area).toBe("catalog");
    expect(row?.defaultGranted).toBe(false);
  });

  it('falls back to "off" and offers exactly the off/on modes with no settings', () => {
    expect(row?.config?.fallbackMode).toBe("off");
    expect(Object.keys(row?.config?.modes ?? {}).sort()).toEqual(["off", "on"]);
    for (const mode of Object.values(row?.config?.modes ?? {})) {
      expect(mode.settings).toEqual([]);
      expect(mode.available).toBe(true);
    }
  });

  it('getEffectiveMode for a tenant with no config row is "off"', async () => {
    const store = {
      getMode: jest.fn().mockResolvedValue({ value: "off", source: "REGISTRY_DEFAULT" }),
      invalidate: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        { provide: PrismaService, useValue: {} },
        { provide: FeatureConfigStore, useValue: store },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AddonService, useValue: { hasAddon: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    const service = module.get(FeatureConfigService);
    await expect(service.getEffectiveMode("tenant-a", "mixed_packs")).resolves.toBe("off");
  });
});
