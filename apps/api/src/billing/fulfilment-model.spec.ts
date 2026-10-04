import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigStore } from "./feature-config.store";
import { FeatureConfigService } from "./feature-config.service";
import { FEATURE_REGISTRY } from "./feature-registry";

/**
 * Business profiles 1A: `fulfilment_model` is a free configuration row ("how do orders reach
 * your customers?"), shaped like `routes_dispatch`. Unset = today's behaviour exactly.
 */
const row = () => FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model");

describe("fulfilment_model registry row", () => {
  it("is a boolean config row that defaults to unset and changes no entitlement", () => {
    const r = row();
    expect(r).toBeDefined();
    expect(r!.config?.fallbackMode).toBe("unset");
    expect(r!.defaultGranted).toBe(true);
    expect(r!.gate.via).toBe("none");
    expect(r!.billing).toEqual({ skus: [], selfService: false });
  });

  it("offers unset / delivery / ship / both, and pickup reserved but unavailable", () => {
    const modes = row()!.config!.modes;
    expect(Object.keys(modes)).toEqual(["unset", "delivery", "ship", "both", "pickup"]);
    expect(modes.unset.label).toBe("Not configured (today's behavior)");
    expect(modes.unset.available).toBe(true);
    for (const m of ["delivery", "ship", "both"]) expect(modes[m].available).toBe(true);
    expect(modes.pickup.available).toBe(false);
    expect(modes.pickup.lifecycle).toBe("proposed");
  });

  it("the mode schema stays allOf-only (the fleet guard lives in the service, not the schema)", () => {
    for (const m of Object.values(row()!.config!.modes)) {
      expect(Object.keys(m.requires ?? {})).not.toContain("anyOf");
      expect(Object.keys(m)).not.toContain("requiresAnyOf");
    }
  });
});

describe("FeatureConfigService: a hand-set delivery/both mode needs a fleet key", () => {
  let service: FeatureConfigService;
  let upsert: jest.Mock;
  let hasAddon: jest.Mock;
  let getMode: jest.Mock;

  beforeEach(async () => {
    upsert = jest.fn().mockResolvedValue({});
    hasAddon = jest.fn();
    getMode = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        {
          provide: PrismaService,
          useValue: {
            tenantFeatureConfig: { upsert, deleteMany: jest.fn() },
            tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1" }) },
          },
        },
        { provide: FeatureConfigStore, useValue: { getMode, invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: AddonService, useValue: { hasAddon } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = module.get(FeatureConfigService);
  });

  it("delivery with neither fleet key -> 409 FEATURE_MODE_REQUIRES, nothing written", async () => {
    hasAddon.mockResolvedValue(false);
    for (const mode of ["delivery", "both"]) {
      const p = service.set("t1", "fulfilment_model", mode, "r", "admin-1");
      await expect(p).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.set("t1", "fulfilment_model", mode, "r", "admin-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "FULFILMENT_MODE_NEEDS_FLEET",
          key: "fulfilment_model",
          mode,
          missing: ["recurring_routes", "order_delivery"],
          message: expect.stringMatching(/Routes.*Order delivery/),
        }),
      });
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("ship is ALLOWED even while both fleet keys are ON (no refusal)", async () => {
    hasAddon.mockResolvedValue(true);
    await service.set("t1", "fulfilment_model", "ship", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("the guard names the code only for fulfilment_model (routes_dispatch keeps FEATURE_MODE_REQUIRES)", async () => {
    hasAddon.mockResolvedValue(false);
    await expect(
      service.set("t1", "routes_dispatch", "scheduled", "r", "admin-1"),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "FEATURE_MODE_REQUIRES" }) });
  });

  it("delivery is allowed with ONE fleet key held", async () => {
    hasAddon.mockImplementation((_t: string, k: string) => Promise.resolve(k === "order_delivery"));
    await service.set("t1", "fulfilment_model", "delivery", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("ship needs no fleet key and writes", async () => {
    hasAddon.mockResolvedValue(false);
    await service.set("t1", "fulfilment_model", "ship", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("pickup is refused as unavailable", async () => {
    await expect(
      service.set("t1", "fulfilment_model", "pickup", "r", "admin-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
