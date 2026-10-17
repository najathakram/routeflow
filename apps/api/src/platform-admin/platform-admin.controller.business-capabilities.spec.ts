/**
 * BO-03: `GET platform-admin/tenants/:id/business-capabilities` and the additive `ticks` on
 * `GET business-profiles`. The route inherits the class-level SuperAdminGuard.
 */
import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { PlatformAdminController } from "./platform-admin.controller";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { BusinessProfileService } from "../billing/business-profile.service";
import { BUSINESS_PROFILES } from "../billing/business-profiles";
import { presetTicks } from "../billing/business-capabilities";

const T = "tenant-acme";

function build(opts: {
  modes?: Record<string, string>;
  addons?: string[];
  overrides?: Record<string, "GRANT" | "DENY">;
  tenantExists?: boolean;
}) {
  const modes = { fulfilment_model: "unset", counter_sales: "unset", ...opts.modes };
  const featureConfig = {
    getEffectiveMode: jest.fn(async (_t: string, key: string) => modes[key as keyof typeof modes]),
    getState: jest.fn(),
  };
  const featureOverrides = {
    list: jest.fn(async () =>
      Object.entries(opts.overrides ?? {}).map(([featureKey, effect], i) => ({
        id: `ov-${i}`,
        tenantId: T,
        featureKey,
        effect,
        revokedAt: null,
        expiresAt: null,
      })),
    ),
    allActive: jest.fn(async () => new Map(Object.entries(opts.overrides ?? {}))),
  };
  const addonService = { getActiveAddons: jest.fn(async () => opts.addons ?? []) };
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(opts.tenantExists === false ? null : { id: T }),
    },
  };
  const service = new BusinessProfileService(
    prisma as never,
    featureOverrides as never,
    addonService as never,
    featureConfig as never,
    {} as never,
  );
  const stub = () => ({}) as any;
  const controller = new PlatformAdminController(
    stub(),
    stub(),
    stub(),
    addonService as any,
    featureOverrides as any,
    stub(),
    stub(),
    stub(),
    stub(),
    stub(),
    stub(),
    service,
    featureConfig as any,
  );
  return controller;
}

describe("business-capabilities route is platform-admin only", () => {
  it("lives on the SuperAdminGuard controller, which refuses every tenant role", () => {
    expect(typeof (PlatformAdminController.prototype as any).getBusinessCapabilities).toBe(
      "function",
    );
    const guards = Reflect.getMetadata(GUARDS_METADATA, PlatformAdminController) as unknown[];
    expect(guards).toContain(SuperAdminGuard);
    const guard = new SuperAdminGuard();
    const ctx = (role: UserRole) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: { role, tenantId: T } }) }) }) as any;
    for (const role of [
      UserRole.TENANT_ADMIN,
      UserRole.OPERATOR,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ]) {
      expect(guard.canActivate(ctx(role))).toBe(false);
    }
    expect(guard.canActivate(ctx(UserRole.SUPER_ADMIN))).toBe(true);
  });
});

describe("GET tenants/:id/business-capabilities", () => {
  it("reads delivery + counter + fleet + driver payments back as delivery_pos", async () => {
    const c = build({
      modes: { fulfilment_model: "delivery", counter_sales: "on" },
      addons: ["recurring_routes", "driver_payments"],
    });
    const res = await c.getBusinessCapabilities(T);
    expect(res).toMatchObject({
      configured: true,
      delivery: true,
      doorPayments: true,
      counter: true,
      fleetHeld: true,
      matchedPreset: "delivery_pos",
    });
  });

  it("a DENY override on driver_payments reads as door payments off", async () => {
    const c = build({
      modes: { fulfilment_model: "delivery", counter_sales: "on" },
      addons: ["recurring_routes", "driver_payments"],
      overrides: { driver_payments: "DENY" },
    });
    const res = await c.getBusinessCapabilities(T);
    expect(res.doorPayments).toBe(false);
    expect(res.matchedPreset).toBeNull();
  });

  it("an unset tenant that holds the fleet reads as not configured, nothing ticked", async () => {
    const c = build({ addons: ["recurring_routes"] });
    const res = await c.getBusinessCapabilities(T);
    expect(res).toMatchObject({ configured: false, delivery: false, counter: false });
    expect(res.matchedPreset).toBeNull();
  });

  it("404s for a missing tenant", async () => {
    const c = build({ tenantExists: false });
    await expect(c.getBusinessCapabilities(T)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("GET business-profiles ticks", () => {
  it("adds each preset's own ticks to its summary", () => {
    const { profiles } = build({}).listBusinessProfiles();
    expect(profiles).toHaveLength(BUSINESS_PROFILES.length);
    for (const p of profiles) {
      const def = BUSINESS_PROFILES.find((d) => d.key === p.key)!;
      expect(p.ticks).toEqual(presetTicks(def));
    }
  });
});
