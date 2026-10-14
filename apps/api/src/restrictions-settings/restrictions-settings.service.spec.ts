import { BadRequestException, ExecutionContext, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SYSTEM_CONFIG_GOVERNING_ADDRESS } from "../selling-restrictions/selling-restrictions.service";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { RestrictionsSettingsService } from "./restrictions-settings.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

const user = { sub: "u1", username: "admin" } as JwtPayload;
/** A stored row of the REMOVED switch: the settings code must neither read nor write it (row 510). */
const REMOVED_SWITCH_KEY = "selling_restrictions.enabled";

function setup(initial: Record<string, string> = {}) {
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
    // Like the real getPolicy: it reads the governing-address row ONLY; any other stored row is invisible to it.
    getPolicy: jest.fn(async () => ({
      addressPrecedence: (store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS) as any) ?? "BILLING_FIRST",
    })),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new RestrictionsSettingsService(prisma as any, engine as any, audit as any);
  return {
    store,
    prisma,
    engine,
    audit,
    service,
    setTenant: (t: string | null) => (tenant = t),
    failOn: (k: string) => (failOnKey = k),
  };
}

describe("RestrictionsSettingsController: roles, and the readiness route is gone (row 510)", () => {
  const proto = RestrictionsSettingsController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (role: UserRole, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => RestrictionsSettingsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext);

  it("OPERATOR may read the settings, not change them; TENANT_ADMIN and SUPER_ADMIN may change them", () => {
    expect(can(UserRole.OPERATOR, "get")).toBe(true);
    expect(can(UserRole.OPERATOR, "update")).toBe(false);
    expect(can(UserRole.TENANT_ADMIN, "update")).toBe(true);
    expect(can(UserRole.SUPER_ADMIN, "update")).toBe(true);
  });

  it("there is no readiness handler and no readiness service method (no web, mobile or api caller was left)", () => {
    expect(proto).not.toHaveProperty("readiness");
    expect(RestrictionsSettingsService.prototype).not.toHaveProperty("readiness");
  });
});

describe("RestrictionsSettingsService: the switch is gone (row 510)", () => {
  it("GET returns the governing address only, no `enabled`, even beside a stored enabled=false row", async () => {
    const s = setup({ [REMOVED_SWITCH_KEY]: "false" });
    const out = await s.service.get();
    expect(out).toEqual({ governingAddress: "BILLING_FIRST" });
    expect(out).not.toHaveProperty("enabled");
  });

  it("PATCH rejects `enabled` under the app's ValidationPipe (400, non-whitelisted) and writes nothing", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const meta = { type: "body", metatype: UpdateRestrictionsSettingsDto } as const;
    await expect(pipe.transform({ enabled: true }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform({ enabled: false }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform({ governingAddress: "SHIPPING_FIRST" }, meta)).resolves.toEqual({
      governingAddress: "SHIPPING_FIRST",
    });
  });

  it("a stored enabled=false row is ignored: the engine's policy still judges, and an update never touches it", async () => {
    const s = setup({ [REMOVED_SWITCH_KEY]: "false" });
    await s.service.update({ governingAddress: "SHIPPING_FIRST" }, user);
    expect(s.store.get(REMOVED_SWITCH_KEY)).toBe("false"); // left exactly as it was
    expect(s.store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe("SHIPPING_FIRST");
  });
});

describe("RestrictionsSettingsService.update", () => {
  it("defaults to BILLING_FIRST on a plain read", async () => {
    const s = setup();
    expect(await s.service.get()).toEqual({ governingAddress: "BILLING_FIRST" });
  });

  it("a precedence change is written in ONE transaction and audited from/to", async () => {
    const s = setup();
    await expect(s.service.update({ governingAddress: "SHIPPING_FIRST" }, user)).resolves.toEqual({
      governingAddress: "SHIPPING_FIRST",
    });
    expect(s.store.get(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe("SHIPPING_FIRST");
    expect(s.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "selling_restrictions.settings_changed",
        meta: {
          from: { governingAddress: "BILLING_FIRST" },
          to: { governingAddress: "SHIPPING_FIRST" },
        },
      }),
    );
  });

  it("a failure mid-write persists nothing and audits nothing", async () => {
    const f = setup();
    f.failOn(SYSTEM_CONFIG_GOVERNING_ADDRESS);
    await expect(f.service.update({ governingAddress: "SHIPPING_FIRST" }, user)).rejects.toThrow(
      "db down mid-write",
    );
    expect(f.store.has(SYSTEM_CONFIG_GOVERNING_ADDRESS)).toBe(false);
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it("a no-op patch writes and audits nothing; a tenant context is required", async () => {
    const s = setup({ [SYSTEM_CONFIG_GOVERNING_ADDRESS]: "SHIPPING_FIRST" });
    await s.service.update({ governingAddress: "SHIPPING_FIRST" }, user);
    await s.service.update({}, user);
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
    s.setTenant(null);
    await expect(s.service.get()).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.service.update({ governingAddress: "BILLING_FIRST" }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
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
        plainToInstance(UpdateRestrictionsSettingsDto, { governingAddress: "SHIPPING_FIRST" }),
      ),
    ).toHaveLength(0);
  });
});
