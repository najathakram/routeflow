import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  HttpException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  SELLING_RESTRICTIONS_NOT_READY,
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
} from "../selling-restrictions/selling-restrictions.service";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { Logger } from "@nestjs/common";
import {
  READINESS_THROTTLE,
  RestrictionsSettingsService,
  SETTINGS_ENABLE_AND_POLICY_TOGETHER,
} from "./restrictions-settings.service";
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
  businessStateMissing: false,
};

function setup(initial: Record<string, string> = {}, ready = true) {
  const store = new Map(Object.entries(initial));
  let tenant: string | null = "t1";
  let failOnKey: string | null = null;
  const tx = {
    systemConfig: {
      findFirst: async ({ where }: any) => (store.has(where.key) ? { id: where.key } : null),
      update: async ({ where, data }: any) => {
        if (where.id === failOnKey) throw new Error("db down mid-write");
        store.set(where.id, data.value);
      },
      create: async ({ data }: any) => {
        if (data.key === failOnKey) throw new Error("db down mid-write");
        store.set(data.key, data.value);
      },
    },
  };
  const prisma = {
    getTenantId: () => tenant,
    // A real transaction's contract: if the callback throws, nothing it wrote persists.
    tenantTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snap = new Map(store);
      try {
        return await fn(tx);
      } catch (e) {
        store.clear();
        snap.forEach((v, k) => store.set(k, v));
        throw e;
      }
    }),
  };
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
  // Fixed-window counter per key, like the repo's RedisThrottlerStorage.
  const hits = new Map<string, number>();
  const limiter = {
    increment: jest.fn(async (key: string) => ({
      totalHits: hits.set(key, (hits.get(key) ?? 0) + 1).get(key)!,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    })),
  };
  const service = new RestrictionsSettingsService(
    prisma as any,
    engine as any,
    audit as any,
    limiter as any,
  );
  return {
    store,
    prisma,
    engine,
    audit,
    limiter,
    service,
    setTenant: (t: string | null) => (tenant = t),
    failOn: (k: string) => (failOnKey = k),
  };
}

describe("readiness: admin-only, throttled per tenant", () => {
  const proto = RestrictionsSettingsController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (role: UserRole, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => RestrictionsSettingsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext);

  it("OPERATOR is denied on the readiness route; TENANT_ADMIN and SUPER_ADMIN are allowed; OPERATOR may still read the settings", () => {
    expect(can(UserRole.OPERATOR, "readiness")).toBe(false);
    expect(can(UserRole.TENANT_ADMIN, "readiness")).toBe(true);
    expect(can(UserRole.SUPER_ADMIN, "readiness")).toBe(true);
    expect(can(UserRole.OPERATOR, "get")).toBe(true);
    expect(can(UserRole.OPERATOR, "update")).toBe(false);
  });

  it("trips with a 429 on the call after the limit for the SAME tenant, and not for another tenant", async () => {
    const s = setup();
    for (let i = 0; i < READINESS_THROTTLE.limit; i++) await s.service.readiness();
    await expect(s.service.readiness()).rejects.toMatchObject({ status: 429 });
    await expect(s.service.readiness()).rejects.toBeInstanceOf(HttpException);
    expect(s.engine.getEnableReadiness).toHaveBeenCalledTimes(READINESS_THROTTLE.limit); // no sweep once tripped
    s.setTenant("t2");
    await expect(s.service.readiness()).resolves.toEqual(READY);
    expect(s.limiter.increment).toHaveBeenLastCalledWith(
      "restrictions-readiness:t2",
      READINESS_THROTTLE.ttl,
      READINESS_THROTTLE.limit,
      0,
      "restrictions-readiness",
    );
  });

  it("an unreachable limiter fails open (it is abuse protection, not an authorisation gate)", async () => {
    const s = setup();
    s.limiter.increment.mockRejectedValue(new Error("redis down"));
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    await expect(s.service.readiness()).resolves.toEqual(READY);
    // The outage is visible AND says which tenant it affected.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tenant t1"));
    warn.mockRestore();
  });
});

describe("RestrictionsSettingsService.update", () => {
  it("defaults to OFF / BILLING_FIRST and never sweeps on a plain read", async () => {
    const s = setup();
    expect(await s.service.get()).toEqual({ enabled: false, governingAddress: "BILLING_FIRST" });
    expect(s.engine.getEnableReadiness).not.toHaveBeenCalled();
  });

  it("enabling checks readiness, writes the engine's own 'true' in ONE transaction, and audits from/to", async () => {
    const s = setup();
    await s.service.update({ enabled: true }, user);
    expect(s.engine.assertReadyToEnable).toHaveBeenCalledWith("t1");
    expect(s.store.get(SYSTEM_CONFIG_ENABLED)).toBe("true");
    expect(s.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "selling_restrictions.settings_changed" }),
    );
  });

  it("an un-ready tenant is refused and NOTHING is written", async () => {
    const s = setup({}, false);
    await expect(s.service.update({ enabled: true }, user)).rejects.toMatchObject({
      response: { code: SELLING_RESTRICTIONS_NOT_READY },
    });
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(s.store.size).toBe(0);
  });

  it("turning enforcement ON while changing the address policy is refused (judge readiness under the policy in force)", async () => {
    const s = setup();
    await expect(
      s.service.update({ enabled: true, governingAddress: "SHIPPING_FIRST" }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s.store.size).toBe(0);
    expect(s.engine.assertReadyToEnable).not.toHaveBeenCalled();
  });

  it("disabling + a precedence change land together; the write is ALL-OR-NOTHING (a failure mid-write persists nothing)", async () => {
    const s = setup({ [SYSTEM_CONFIG_ENABLED]: "true" });
    await s.service.update({ enabled: false, governingAddress: "SHIPPING_FIRST" }, user);
    expect(s.store.get(SYSTEM_CONFIG_ENABLED)).toBe("false");
    expect(s.store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe("SHIPPING_FIRST");

    // The precedence write (first) succeeds, then the "enabled" write (second) fails: the first must not persist.
    const f = setup({ [SYSTEM_CONFIG_ENABLED]: "true" });
    f.failOn(SYSTEM_CONFIG_ENABLED);
    await expect(
      f.service.update({ enabled: false, governingAddress: "SHIPPING_FIRST" }, user),
    ).rejects.toThrow("db down mid-write");
    expect(f.store.get(SYSTEM_CONFIG_ENABLED)).toBe("true");
    expect(f.store.has(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe(false); // rolled back with it
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it("a no-op patch writes and audits nothing and skips the sweep; a tenant context is required", async () => {
    const s = setup({
      [SYSTEM_CONFIG_ENABLED]: "true",
      [SYSTEM_CONFIG_GOVERNING_ADDRESS]: "SHIPPING_FIRST",
    });
    await s.service.update({ enabled: true, governingAddress: "SHIPPING_FIRST" }, user);
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(s.engine.assertReadyToEnable).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
    s.setTenant(null);
    await expect(s.service.get()).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.readiness()).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.update({ enabled: true }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("only BILLING_FIRST / SHIPPING_FIRST pass validation", async () => {
    expect(
      (
        await validate(
          plainToInstance(UpdateRestrictionsSettingsDto, { governingAddress: "DELIVERY" }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      await validate(
        plainToInstance(UpdateRestrictionsSettingsDto, {
          enabled: true,
          governingAddress: "SHIPPING_FIRST",
        }),
      ),
    ).toHaveLength(0);
  });
});
