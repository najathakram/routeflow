/**
 * FG-1 WP3 (T8): the `live` door. `PUT entitlements/mode` opens only when the entitlement sweep reads 0 courtesy gaps
 * and 0 unexplained; `force` is gone (no body can open it); a sweep that does not finish, or is not wired, refuses.
 * The sweep itself is faked here; its counting is proven in entitlement-sweep.service.spec.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PlatformAdminController } from "./platform-admin.controller";
import { SetEntitlementsModeDto } from "./dto/set-entitlements-mode.dto";
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from "../common/global-validation-pipe";

function stub() {
  return new Proxy({}, { get: () => jest.fn() });
}

type Verdict = Record<string, unknown>;
const CLEAR: Verdict = { clear: true, tenants: 4 };
const GAP: Verdict = { clear: false, reason: "gaps", courtesyGaps: 2, unexplained: 0, tenants: 4 };

function make(verdict: Verdict | null) {
  const entitlementsMode = { setMode: jest.fn().mockResolvedValue(undefined) };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const sweep = verdict ? { liveDoor: jest.fn().mockResolvedValue(verdict) } : undefined;
  const controller = new PlatformAdminController(
    svc as any,
    stub() as any, // platformConfig
    stub() as any, // billingService
    stub() as any, // addonService
    stub() as any, // featureOverrides
    entitlementsMode as any,
    stub() as any, // configSnapshotFlag
    stub() as any, // featureDiffs
    stub() as any, // authority
    stub() as any, // featurePreview
    stub() as any, // snapshotAdmin
    stub() as any, // businessProfiles
    stub() as any, // featureConfig
    stub() as any, // applyService
    sweep as any,
  );
  return { controller, entitlementsMode, svc, sweep };
}

const admin = { sub: "admin-1" } as any;

describe("PUT entitlements/mode: the live door", () => {
  it("T8: refuses live while a courtesy gap exists, even with force and a reason", async () => {
    const { controller, entitlementsMode, svc } = make(GAP);
    const dto = { mode: "live", force: true, reason: "owner says so" } as any;
    const err = await controller.setEntitlementsMode(dto, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      statusCode: 409,
      message: "Can't switch to live. 2 feature checks would lose access. Nothing was changed.",
    });
    expect(entitlementsMode.setMode).not.toHaveBeenCalled();
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it("T8: refuses live when the sweep did not finish in time", async () => {
    const { controller, entitlementsMode } = make({
      clear: false,
      reason: "timeout",
      courtesyGaps: 0,
      unexplained: 0,
      tenants: 1,
    });
    await expect(
      controller.setEntitlementsMode({ mode: "live" } as any, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(entitlementsMode.setMode).not.toHaveBeenCalled();
  });

  it("T8: refuses live when no sweep is wired (fail closed)", async () => {
    const { controller, entitlementsMode } = make(null);
    await expect(
      controller.setEntitlementsMode({ mode: "live" } as any, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(entitlementsMode.setMode).not.toHaveBeenCalled();
  });

  it("opens only on a clear sweep, and the audit entry carries no force", async () => {
    const { controller, entitlementsMode, svc } = make(CLEAR);
    await expect(
      controller.setEntitlementsMode({ mode: "live", reason: "stage F" } as any, admin),
    ).resolves.toEqual({ mode: "live" });
    expect(entitlementsMode.setMode).toHaveBeenCalledWith("live");
    expect(svc.recordAdminAction.mock.calls[0][3]).toEqual({ mode: "live", reason: "stage F" });
  });

  it("shadow never runs the sweep and is always allowed", async () => {
    const { controller, entitlementsMode, sweep } = make(GAP);
    await controller.setEntitlementsMode({ mode: "shadow" } as any, admin);
    expect(sweep!.liveDoor).not.toHaveBeenCalled();
    expect(entitlementsMode.setMode).toHaveBeenCalledWith("shadow");
  });
});

describe("T8: `force` is deleted", () => {
  it("the DTO no longer accepts it: the global pipe's options reject the field", async () => {
    const dto = plainToInstance(SetEntitlementsModeDto, { mode: "live", force: true });
    const errors = await validate(dto, {
      whitelist: GLOBAL_VALIDATION_PIPE_OPTIONS.whitelist,
      forbidNonWhitelisted: GLOBAL_VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted,
    });
    expect(errors.map((e) => e.property)).toContain("force");
  });

  it("the door in the controller reads no `force` flag", () => {
    const src = readFileSync(join(__dirname, "platform-admin.controller.ts"), "utf8");
    const door = src.slice(
      src.indexOf('@Put("entitlements/mode")'),
      src.indexOf('@Get("entitlements/config-snapshot")'),
    );
    expect(door.length).toBeGreaterThan(200);
    expect(door).not.toMatch(/\bforce\b/);
  });

  it("the controller is the ONE non-spec caller of EntitlementsModeService.setMode", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.spec\.ts$/.test(name)) {
          if (/(entitlementsMode|modeService)\??\.setMode\(/.test(readFileSync(p, "utf8"))) {
            callers.push(name);
          }
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(callers).toEqual(["platform-admin.controller.ts"]);
  });
});
