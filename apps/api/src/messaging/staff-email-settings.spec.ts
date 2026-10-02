import { ForbiddenException } from "@nestjs/common";
import { BadRequestException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../auth/guards/roles.guard";
import { MessagingController } from "./messaging.controller";
import { StaffEmailSettingsService } from "./staff-email-settings.service";
import { StaffOrderEmailService } from "./staff-order-email";
import {
  STAFF_CC_INVALID_REASON_VALUES,
  STAFF_CC_MAX,
} from "../../../../packages/types/api/staff-order-email";
import { API_ERROR_CODES } from "../../../../packages/types/api/error-codes";
import { API_ERROR_CODES as API_LOCAL } from "../common/api-error-codes";

/**
 * WS4 (SA-606) — `GET/PUT /messaging/staff-email-settings`. Storage is the tenant SystemConfig
 * row `notifications.staffCc` (JSON array string), always through `prisma.forTenant()`.
 */

type Row = Record<string, unknown>;

function makeHarness(stored?: unknown, env?: string) {
  const rows: Row[] =
    stored === undefined
      ? []
      : [{ id: "cfg1", key: "notifications.staffCc", value: JSON.stringify(stored) }];
  const systemConfig = {
    findFirst: jest.fn(async () => rows[0] ?? null),
    update: jest.fn(async ({ data }: { data: { value: string } }) => {
      rows[0] = { ...rows[0], value: data.value };
      return rows[0];
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      rows.push({ id: "new", ...data });
      return rows[rows.length - 1];
    }),
  };
  const user = {
    findMany: jest
      .fn()
      .mockResolvedValue([{ id: "u1", email: "boss@acme.test", role: "TENANT_ADMIN" }]),
  };
  const models = { systemConfig, user };
  const prisma = {
    forTenant: jest.fn().mockReturnValue(models),
    getTenantId: jest.fn().mockReturnValue("t1"),
    systemConfig: undefined,
  };
  const staff = new StaffOrderEmailService(prisma as never, {} as never, {} as never);
  const svc = new StaffEmailSettingsService(prisma as never, staff);
  if (env === undefined) delete process.env.STAFF_ORDER_EMAIL;
  else process.env.STAFF_ORDER_EMAIL = env;
  return { svc, staff, prisma, systemConfig, rows };
}

async function rejection(p: Promise<unknown>): Promise<BadRequestException> {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error("expected rejection");
}

describe("StaffEmailSettingsService", () => {
  const OLD_ENV = process.env.STAFF_ORDER_EMAIL;
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.STAFF_ORDER_EMAIL;
    else process.env.STAFF_ORDER_EMAIL = OLD_ENV;
  });

  describe("GET", () => {
    it("TENANT_ADMIN sees the addresses in full", async () => {
      const { svc } = makeHarness(["jane@acme.test", "bob@acme.test"]);
      expect((await svc.get("TENANT_ADMIN")).staffCc).toEqual(["jane@acme.test", "bob@acme.test"]);
    });
    it("OPERATOR sees them masked", async () => {
      const { svc } = makeHarness(["jane@acme.test", "bob@acme.test"]);
      expect((await svc.get("OPERATOR")).staffCc).toEqual(["j***@acme.test", "b***@acme.test"]);
    });
    it("no row => empty list", async () => {
      const { svc } = makeHarness();
      expect((await svc.get("TENANT_ADMIN")).staffCc).toEqual([]);
    });
    it("malformed stored value => empty list", async () => {
      const h = makeHarness();
      h.systemConfig.findFirst.mockResolvedValue({ id: "x", key: "k", value: "not json" } as never);
      expect((await h.svc.get("TENANT_ADMIN")).staffCc).toEqual([]);
    });
    it.each([
      ["off", "off"],
      ["dark", "dark"],
      ["on", "dark"], // policy term is dark => min
      [undefined, "dark"],
      ["garbage", "dark"],
    ] as const)("effectiveMode with env %s is %s (policy dark)", async (env, expected) => {
      const { svc } = makeHarness([], env);
      expect((await svc.get("TENANT_ADMIN")).effectiveMode).toBe(expected);
    });
    it("effectiveMode follows the policy term (env on)", async () => {
      const { svc, staff } = makeHarness([], "on");
      staff.policyMode = "on";
      expect((await svc.get("TENANT_ADMIN")).effectiveMode).toBe("on");
      staff.policyMode = "dark";
      expect((await svc.get("TENANT_ADMIN")).effectiveMode).toBe("dark");
    });
    it("reads env at call time", async () => {
      const { svc } = makeHarness([], "off");
      expect((await svc.get("TENANT_ADMIN")).effectiveMode).toBe("off");
      process.env.STAFF_ORDER_EMAIL = "dark";
      expect((await svc.get("TENANT_ADMIN")).effectiveMode).toBe("dark");
    });
  });

  describe("PUT", () => {
    it("creates the row as a JSON array string and returns the new settings", async () => {
      const { svc, systemConfig } = makeHarness();
      const out = await svc.update({ staffCc: ["a@acme.test"] });
      expect(systemConfig.create).toHaveBeenCalledWith({
        data: { key: "notifications.staffCc", value: JSON.stringify(["a@acme.test"]) },
      });
      expect(out.staffCc).toEqual(["a@acme.test"]);
    });
    it("updates an existing row in place", async () => {
      const { svc, systemConfig, rows } = makeHarness(["old@acme.test"]);
      await svc.update({ staffCc: ["new@acme.test"] });
      expect(systemConfig.update).toHaveBeenCalledWith({
        where: { id: "cfg1" },
        data: { value: JSON.stringify(["new@acme.test"]) },
      });
      expect(systemConfig.create).not.toHaveBeenCalled();
      expect(JSON.parse(String(rows[0].value))).toEqual(["new@acme.test"]);
    });
    it("normalizes: trim + lowercase", async () => {
      const { svc, rows } = makeHarness();
      const out = await svc.update({ staffCc: ["  Jane@Acme.TEST "] });
      expect(out.staffCc).toEqual(["jane@acme.test"]);
      expect(JSON.parse(String(rows[0].value))).toEqual(["jane@acme.test"]);
    });
    it("empty array clears it", async () => {
      const { svc, rows } = makeHarness(["a@acme.test"]);
      const out = await svc.update({ staffCc: [] });
      expect(out.staffCc).toEqual([]);
      expect(JSON.parse(String(rows[0].value))).toEqual([]);
    });
    it("accepts exactly 5 valid addresses", async () => {
      const { svc } = makeHarness();
      const list = Array.from({ length: STAFF_CC_MAX }, (_, i) => `u${i}@acme.test`);
      expect((await svc.update({ staffCc: list })).staffCc).toEqual(list);
    });
    it("6 addresses => 400 too_many at index 0", async () => {
      const { svc, systemConfig } = makeHarness();
      const list = Array.from({ length: STAFF_CC_MAX + 1 }, (_, i) => `u${i}@acme.test`);
      const e = await rejection(svc.update({ staffCc: list }));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse()).toMatchObject({
        code: API_LOCAL.STAFF_CC_INVALID,
        details: { index: 0, reason: "too_many" },
      });
      expect(systemConfig.create).not.toHaveBeenCalled();
    });
    it.each(["a@placeholder.local", "B@Imported.LOCAL"])(
      "sentinel address %s => 400 STAFF_CC_INVALID reason sentinel",
      async (addr) => {
        const { svc } = makeHarness([]);
        const e = await svc.update({ staffCc: ["ok@acme.test", addr] }).catch((x) => x);
        expect(e).toBeInstanceOf(BadRequestException);
        expect(e.getResponse()).toMatchObject({
          code: API_LOCAL.STAFF_CC_INVALID,
          details: { index: 1, reason: "sentinel" },
        });
      },
    );

    it("invalid format => 400 with index + reason", async () => {
      const { svc } = makeHarness();
      const e = await rejection(svc.update({ staffCc: ["ok@acme.test", "nope"] }));
      expect(e.getResponse()).toMatchObject({
        code: "STAFF_CC_INVALID",
        details: { index: 1, reason: "format" },
      });
    });
    it("non-string entry => 400 format", async () => {
      const { svc } = makeHarness();
      const e = await rejection(svc.update({ staffCc: [42 as never] }));
      expect(e.getResponse()).toMatchObject({ details: { index: 0, reason: "format" } });
    });
    it("non-array body => 400 format at 0", async () => {
      const { svc } = makeHarness();
      const e = await rejection(svc.update({ staffCc: "a@b.co" as never }));
      expect(e.getResponse()).toMatchObject({ details: { index: 0, reason: "format" } });
    });
    it("case-insensitive duplicate => 400 at the second index", async () => {
      const { svc } = makeHarness();
      const e = await rejection(
        svc.update({ staffCc: ["a@acme.test", "b@acme.test", " A@ACME.test"] }),
      );
      expect(e.getResponse()).toMatchObject({
        code: "STAFF_CC_INVALID",
        details: { index: 2, reason: "duplicate" },
      });
    });
    it("ignores extra body fields (effectiveMode is never persisted)", async () => {
      const { svc, systemConfig } = makeHarness();
      const out = await svc.update({ staffCc: ["a@acme.test"], effectiveMode: "on" } as never);
      expect(out.effectiveMode).not.toBe("on");
      expect(systemConfig.create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(systemConfig.create.mock.calls[0])).not.toContain("effectiveMode");
    });
    it("reason codes / error code match the shared source", () => {
      expect([...STAFF_CC_INVALID_REASON_VALUES]).toEqual([
        "format",
        "duplicate",
        "too_many",
        "sentinel",
      ]);
      expect(API_ERROR_CODES.STAFF_CC_INVALID).toBe(API_LOCAL.STAFF_CC_INVALID);
    });
  });

  describe("tenant scoping", () => {
    it("writes only through forTenant(); another tenant's row is untouched", async () => {
      const a = makeHarness(["a@a.test"]);
      const b = makeHarness(["b@b.test"]);
      await a.svc.update({ staffCc: ["x@a.test"] });
      expect(a.prisma.forTenant).toHaveBeenCalled();
      expect(a.systemConfig.update).toHaveBeenCalledTimes(1);
      expect(b.systemConfig.update).not.toHaveBeenCalled();
      expect(b.systemConfig.create).not.toHaveBeenCalled();
      expect(JSON.parse(String(b.rows[0].value))).toEqual(["b@b.test"]);
    });
    it("never touches a raw (unscoped) prisma.systemConfig", async () => {
      const h = makeHarness();
      await h.svc.get("TENANT_ADMIN");
      await h.svc.update({ staffCc: ["a@acme.test"] });
      expect(h.prisma.systemConfig).toBeUndefined();
    });
  });

  describe("round trip with StaffOrderEmailService.resolveRecipients", () => {
    it("the written value is read back as recipients (admins + cc)", async () => {
      const { svc, staff } = makeHarness();
      await svc.update({ staffCc: [" Cc1@Acme.test", "cc2@acme.test"] });
      expect(await staff.resolveRecipients("t1")).toEqual([
        "boss@acme.test",
        "cc1@acme.test",
        "cc2@acme.test",
      ]);
    });
  });
});

describe("MessagingController staff-email-settings routes", () => {
  const guard = new RolesGuard(new Reflector());
  const ctx = (handler: unknown, role: string) =>
    ({
      getHandler: () => handler,
      getClass: () => MessagingController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;
  const proto = MessagingController.prototype as unknown as Record<string, unknown>;

  it("PUT is TENANT_ADMIN only (OPERATOR denied)", () => {
    expect(guard.canActivate(ctx(proto.updateStaffEmailSettings, "OPERATOR"))).toBe(false);
    expect(guard.canActivate(ctx(proto.updateStaffEmailSettings, "TENANT_ADMIN"))).toBe(true);
  });
  it("GET allows OPERATOR and TENANT_ADMIN", () => {
    expect(guard.canActivate(ctx(proto.getStaffEmailSettings, "OPERATOR"))).toBe(true);
    expect(guard.canActivate(ctx(proto.getStaffEmailSettings, "TENANT_ADMIN"))).toBe(true);
  });
  it("delegates with the caller role / the body", async () => {
    const settings = {
      get: jest.fn().mockResolvedValue("g"),
      update: jest.fn().mockResolvedValue("u"),
    };
    const c = new MessagingController({} as never, {} as never, {} as never, settings as never);
    expect(await c.getStaffEmailSettings({ role: "OPERATOR" })).toBe("g");
    expect(settings.get).toHaveBeenCalledWith("OPERATOR");
    expect(await c.updateStaffEmailSettings({ staffCc: ["a@b.co"] })).toBe("u");
    expect(settings.update).toHaveBeenCalledWith({ staffCc: ["a@b.co"] });
  });

  describe("no tenant context (SUPER_ADMIN / job): refused, nothing read or written", () => {
    it.each([
      ["GET", (h: ReturnType<typeof makeHarness>) => h.svc.get("TENANT_ADMIN")],
      ["PUT", (h: ReturnType<typeof makeHarness>) => h.svc.update({ staffCc: ["a@example.com"] })],
    ])("%s throws a coded 403 and never touches the unscoped client", async (_l, call) => {
      const h = makeHarness();
      (h.prisma.getTenantId as jest.Mock).mockReturnValue(null);
      const err: any = await call(h).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
      expect(h.prisma.forTenant).not.toHaveBeenCalled();
    });
  });
});
