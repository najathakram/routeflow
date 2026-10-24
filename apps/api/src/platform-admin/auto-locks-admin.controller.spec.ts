import "reflect-metadata";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AUTO_LOCK_KIND_VALUES } from "@routeflow/types";
import { AutoLocksAdminController } from "./auto-locks-admin.controller";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { SetAutoLocksDto } from "./dto/set-auto-locks.dto";
import { AdminAuditAction } from "./audit-actions.constant";
import { AUTO_LOCK_KINDS } from "../billing/auto-lock-gate";
import { AutoLockAdminService } from "../billing/auto-lock-admin.service";

const ctx = (user: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

function make() {
  const state = { paused: true, since: null, reason: null, wouldLockNow: [], skipped: [] };
  const prev = { paused: true, since: null, reason: null };
  const autoLocks = {
    getState: jest.fn().mockResolvedValue(state),
    preview: jest.fn().mockResolvedValue({ generatedAt: "t", paused: true, wouldLock: [] }),
    setPaused: jest.fn().mockResolvedValue({
      paused: false,
      since: "2026-10-13T00:00:00.000Z",
      reason: "go live",
      previous: prev,
    }),
  };
  const admin = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  return {
    c: new AutoLocksAdminController(autoLocks as any, admin as any),
    autoLocks,
    admin,
    prev,
  };
}

describe("AutoLocksAdminController", () => {
  it("every route sits behind JwtAuthGuard + SuperAdminGuard (class-level)", () => {
    expect(Reflect.getMetadata("__guards__", AutoLocksAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
  });

  it("a non-super-admin is refused by the guard (every other role, and no user)", () => {
    const guard = new SuperAdminGuard();
    for (const role of ["TENANT_ADMIN", "OPERATOR", "DRIVER", "CUSTOMER", undefined]) {
      expect(guard.canActivate(ctx({ role }))).toBe(false);
    }
    expect(guard.canActivate(ctx(undefined))).toBe(false);
    expect(guard.canActivate(ctx({ role: "SUPER_ADMIN" }))).toBe(true);
    // (Nest turns `false` into the 403 ForbiddenException; pin the exception type the framework raises.)
    expect(new ForbiddenException().getStatus()).toBe(403);
  });

  it("paths and verbs are pinned: GET state, GET preview, PATCH switch", () => {
    const p = AutoLocksAdminController.prototype;
    expect(Reflect.getMetadata("path", p.state)).toBe("config/auto-locks");
    expect(Reflect.getMetadata("method", p.state)).toBe(0); // GET
    expect(Reflect.getMetadata("path", p.preview)).toBe("config/auto-locks/preview");
    expect(Reflect.getMetadata("method", p.preview)).toBe(0);
    expect(Reflect.getMetadata("path", p.set)).toBe("config/auto-locks");
    expect(Reflect.getMetadata("method", p.set)).toBe(4); // PATCH
    expect(Reflect.getMetadata("path", AutoLocksAdminController)).toBe("platform-admin");
  });

  it("GET state and GET preview delegate and never write or audit", async () => {
    const { c, autoLocks, admin } = make();
    await c.state();
    await c.preview();
    expect(autoLocks.getState).toHaveBeenCalledTimes(1);
    expect(autoLocks.preview).toHaveBeenCalledTimes(1);
    expect(autoLocks.setPaused).not.toHaveBeenCalled();
    expect(admin.recordAdminAction).not.toHaveBeenCalled();
  });

  it("PATCH flips the switch and writes ONE audit row PLATFORM_AUTO_LOCKS_SWITCHED with {paused, reason, previous}", async () => {
    const { c, autoLocks, admin, prev } = make();
    const res = await c.set({ paused: false, reason: "go live" }, { sub: "sa-1" } as any);
    expect(autoLocks.setPaused).toHaveBeenCalledWith(false, "go live", "sa-1");
    expect(admin.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(admin.recordAdminAction).toHaveBeenCalledWith(
      null,
      "sa-1",
      AdminAuditAction.PLATFORM_AUTO_LOCKS_SWITCHED,
      { paused: false, reason: "go live", previous: prev },
    );
    expect(res).toMatchObject({ paused: false, reason: "go live" });
  });

  it("the audit action exists with a label", () => {
    expect(AdminAuditAction.PLATFORM_AUTO_LOCKS_SWITCHED).toBe("PLATFORM_AUTO_LOCKS_SWITCHED");
  });

  it("the API kind list is set-equal to the shared wire list (L-072 parity)", () => {
    expect([...AUTO_LOCK_KINDS].sort()).toEqual([...AUTO_LOCK_KIND_VALUES].sort());
  });
});

describe("SetAutoLocksDto", () => {
  const run = (body: Record<string, unknown>) => validate(plainToInstance(SetAutoLocksDto, body));

  it("accepts paused true/false with a real reason", async () => {
    expect(await run({ paused: true, reason: "rollout week" })).toHaveLength(0);
    expect(await run({ paused: false, reason: "owner ruling 2026-10-13" })).toHaveLength(0);
  });

  it("requires a reason: missing, empty, whitespace-only, under 3 and over 500 characters are refused", async () => {
    for (const reason of [undefined, "", "   ", "ok", "x".repeat(501)]) {
      const errors = await run({ paused: true, reason });
      expect(errors.some((e) => e.property === "reason")).toBe(true);
    }
  });

  it("trims the reason before it is audited", () => {
    expect(plainToInstance(SetAutoLocksDto, { paused: true, reason: "  go live  " }).reason).toBe(
      "go live",
    );
  });

  it("requires a boolean paused (no truthy strings)", async () => {
    for (const paused of [undefined, "false", "true", 1, 0, null]) {
      const errors = await run({ paused, reason: "rollout week" });
      expect(errors.some((e) => e.property === "paused")).toBe(true);
    }
  });
});

describe("AutoLockAdminService.setPaused", () => {
  it("reads the previous value from the database (cache invalidated first), then writes", async () => {
    const order: string[] = [];
    const sw = {
      invalidate: jest.fn(() => order.push("invalidate")),
      getState: jest.fn(async () => {
        order.push("get");
        return { paused: true, since: null, reason: null, by: null };
      }),
      setPaused: jest.fn(async () => {
        order.push("set");
        return { paused: false, since: new Date("2026-10-13T00:00:00Z"), reason: "r", by: "u" };
      }),
    };
    const svc = new AutoLockAdminService({} as any, sw as any);
    const res = await svc.setPaused(false, "r", "u");
    expect(order).toEqual(["invalidate", "get", "set"]);
    expect(res).toEqual({
      paused: false,
      since: "2026-10-13T00:00:00.000Z",
      reason: "r",
      previous: { paused: true, since: null, reason: null },
    });
  });
});
