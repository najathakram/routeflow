import { BadRequestException, ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  SELLING_RESTRICTIONS_NOT_READY,
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
} from "../selling-restrictions/selling-restrictions.service";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { RestrictionsSettingsService } from "./restrictions-settings.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

const user = { sub: "u1", username: "admin" } as JwtPayload;
const READY = {
  ready: true,
  truncated: false,
  customerCount: 3,
  customersWithoutAddress: 0,
  customersAmbiguousNoDefault: 0,
  addressesMissingStateCode: 0,
  addressesNeedingReview: 0,
  indeterminateCustomerCount: 0,
};

function setup(initial: Record<string, string> = {}, ready = true) {
  const store = new Map(Object.entries(initial));
  const config = { set: jest.fn(async (k: string, v: string) => void store.set(k, v)) };
  const engine = {
    getPolicy: jest.fn(async () => ({
      enabled: store.has(SYSTEM_CONFIG_ENABLED) && store.get(SYSTEM_CONFIG_ENABLED) !== "false",
      addressPrecedence: (store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS) as any) ?? "BILLING_FIRST",
    })),
    getEnableReadiness: jest.fn(async () => READY),
    assertReadyToEnable: jest.fn(async () => {
      if (!ready)
        throw new ConflictException({
          code: SELLING_RESTRICTIONS_NOT_READY,
          readiness: { ...READY, ready: false },
        });
      return READY;
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const prisma = { getTenantId: jest.fn().mockReturnValue("t1") };
  const service = new RestrictionsSettingsService(
    prisma as any,
    config as any,
    engine as any,
    audit as any,
  );
  return { store, config, engine, audit, prisma, service };
}

describe("RestrictionsSettingsService", () => {
  it("defaults to OFF / BILLING_FIRST, and only runs the customer sweep when asked", async () => {
    const s = setup();
    expect(await s.service.get()).toEqual({
      enabled: false,
      governingAddress: "BILLING_FIRST",
      readiness: null,
    });
    expect(s.engine.getEnableReadiness).not.toHaveBeenCalled();
    expect((await s.service.get(true)).readiness).toEqual(READY);
  });

  it("enabling checks readiness first, writes the engine's own 'true', and audits from/to", async () => {
    const s = setup();
    await s.service.update({ enabled: true }, user);
    expect(s.engine.assertReadyToEnable).toHaveBeenCalledWith("t1");
    expect(s.store.get(SYSTEM_CONFIG_ENABLED)).toBe("true");
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "selling_restrictions.settings_changed",
        meta: {
          from: { enabled: false, governingAddress: "BILLING_FIRST" },
          to: { enabled: true, governingAddress: "BILLING_FIRST" },
        },
      }),
    );
  });

  it("an un-ready tenant is refused with the readiness, nothing written — and a precedence change in the same request is rolled back", async () => {
    const s = setup({}, false);
    await expect(
      s.service.update({ enabled: true, governingAddress: "SHIPPING_FIRST" }, user),
    ).rejects.toMatchObject({ response: { code: SELLING_RESTRICTIONS_NOT_READY } });
    expect(s.store.has(SYSTEM_CONFIG_ENABLED)).toBe(false);
    expect(s.store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe("BILLING_FIRST"); // restored
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it("disabling writes 'false'; a precedence-only change checks no readiness", async () => {
    const s = setup({ [SYSTEM_CONFIG_ENABLED]: "true" });
    await s.service.update({ enabled: false }, user);
    expect(s.store.get(SYSTEM_CONFIG_ENABLED)).toBe("false");
    await s.service.update({ governingAddress: "SHIPPING_FIRST" }, user);
    expect(s.store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe("SHIPPING_FIRST");
    expect(s.engine.assertReadyToEnable).not.toHaveBeenCalled();
  });

  it("a no-op patch (same values, or enabling when already on) writes and audits nothing, and skips the sweep", async () => {
    const s = setup({
      [SYSTEM_CONFIG_ENABLED]: "true",
      [SYSTEM_CONFIG_GOVERNING_ADDRESS]: "SHIPPING_FIRST",
    });
    await s.service.update({ enabled: true, governingAddress: "SHIPPING_FIRST" }, user);
    expect(s.config.set).not.toHaveBeenCalled();
    expect(s.engine.assertReadyToEnable).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it("refuses without a tenant context", async () => {
    const s = setup();
    s.prisma.getTenantId.mockReturnValue(null);
    await expect(s.service.get()).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.update({ enabled: true }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("restrictions settings wiring", () => {
  it("only BILLING_FIRST / SHIPPING_FIRST pass validation", async () => {
    const bad = plainToInstance(UpdateRestrictionsSettingsDto, { governingAddress: "DELIVERY" });
    expect((await validate(bad)).length).toBeGreaterThan(0);
    const ok = plainToInstance(UpdateRestrictionsSettingsDto, {
      enabled: true,
      governingAddress: "SHIPPING_FIRST",
    });
    expect(await validate(ok)).toHaveLength(0);
  });

  it("reads are OPERATOR, the PATCH is TENANT_ADMIN, and the class is behind both guards", () => {
    const proto = RestrictionsSettingsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, proto.get)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.update)).toEqual([UserRole.TENANT_ADMIN]);
    const guards = (Reflect.getMetadata("__guards__", RestrictionsSettingsController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });
});
