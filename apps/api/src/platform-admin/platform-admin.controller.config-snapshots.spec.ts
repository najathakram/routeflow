import { ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { PlatformAdminController } from "./platform-admin.controller";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AdminAuditAction } from "./audit-actions.constant";

// Lane B A2 step c — the controller only routes + audits; the rules live in
// TenantConfigSnapshotAdminService (its own spec). SuperAdminGuard is class-level.
const UUID_A = "3f1c1f2e-8a41-4d59-9d0e-6d6f0d8f2a11";
const UUID_B = "9b2d5c7a-1e3f-4a68-b7c4-2f0e8a1d3c55";

function build() {
  const snapshotAdmin = {
    list: jest.fn().mockResolvedValue([{ id: "s1" }]),
    preview: jest.fn().mockResolvedValue({ snapshotId: "s1" }),
    restoreNow: jest.fn().mockResolvedValue({
      snapshotId: "s1",
      takenAt: new Date("2026-09-10T00:00:00Z"),
      planKey: "SCALE",
      restoredToPlanKey: "SCALE",
      report: { restored: 2, skipped: 0, keptNewer: 1, unchanged: 0 },
    }),
  };
  const configSnapshotFlag = {
    isEnabled: jest.fn().mockResolvedValue(false),
    setEnabled: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(),
  };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const controller = new PlatformAdminController(
    svc as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    configSnapshotFlag as never,
    undefined as never,
    undefined as never,
    undefined as never,
    snapshotAdmin as never,
    undefined as never, // businessProfiles
    undefined as never, // featureConfig
  );
  return { controller, snapshotAdmin, configSnapshotFlag, svc };
}

describe("PlatformAdminController — config snapshots", () => {
  it("lists and previews by tenant + snapshot id", async () => {
    const { controller, snapshotAdmin } = build();
    await controller.listConfigSnapshots(UUID_A);
    await controller.previewConfigSnapshotRestore(UUID_A, UUID_B);
    expect(snapshotAdmin.list).toHaveBeenCalledWith(UUID_A);
    expect(snapshotAdmin.preview).toHaveBeenCalledWith(UUID_A, UUID_B);
  });

  it("Restore Now passes the acting admin to the service, which audits INSIDE the restore transaction", async () => {
    const { controller, snapshotAdmin, svc } = build();

    const res = await controller.restoreConfigSnapshot(UUID_A, UUID_B, { sub: "admin-1" } as never);

    expect(snapshotAdmin.restoreNow).toHaveBeenCalledWith(UUID_A, UUID_B, "admin-1");
    expect(res).toMatchObject({ snapshotId: "s1" });
    // No second, post-commit audit write that could be lost while the restore stands.
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it("a failed restore is NOT audited as a success", async () => {
    const { controller, snapshotAdmin, svc } = build();
    snapshotAdmin.restoreNow.mockRejectedValueOnce(new Error("409"));

    await expect(
      controller.restoreConfigSnapshot(UUID_A, UUID_B, { sub: "admin-1" } as never),
    ).rejects.toThrow("409");
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it.each([
    "listConfigSnapshots",
    "previewConfigSnapshotRestore",
    "restoreConfigSnapshot",
  ] as const)(
    "%s validates every id param as a UUID (a malformed id is a 400, never a 500)",
    async (method) => {
      const meta = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        PlatformAdminController,
        method,
      ) as Record<string, { data: string; pipes: unknown[] }>;
      const params = Object.values(meta).filter((m) => m.data === "id" || m.data === "snapshotId");
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) expect(p.pipes).toContain(ParseUUIDPipe);

      await expect(
        new ParseUUIDPipe().transform("not-a-uuid", { type: "param", data: "id" }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});

// SA-brief: entitlements.configSnapshot is one of the four production flags an agent never
// flips. GET/PUT entitlements/config-snapshot inherit the class-level
// @UseGuards(JwtAuthGuard, SuperAdminGuard) like every other route here — a non-super-admin is
// refused before either handler runs. "A missing reason is refused" is a DTO-validation
// concern (class-validator runs before the controller method), pinned in
// set-config-snapshot-flag.dto.spec.ts, not re-tested here.
describe("PlatformAdminController — config snapshot flag", () => {
  it("the class-level guards cover GET and PUT entitlements/config-snapshot (no route-level override)", () => {
    const guards = (Reflect.getMetadata("__guards__", PlatformAdminController) ?? []) as unknown[];
    expect(guards).toContain(SuperAdminGuard);
    expect(guards).toContain(JwtAuthGuard);
    // No per-method @UseGuards on either handler that could narrow or bypass the class guard.
    expect(
      Reflect.getMetadata("__guards__", PlatformAdminController.prototype.getConfigSnapshotFlag),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata("__guards__", PlatformAdminController.prototype.setConfigSnapshotFlag),
    ).toBeUndefined();
  });

  it("GET reads the flag's current value and never calls setEnabled", async () => {
    const { controller, configSnapshotFlag } = build();
    configSnapshotFlag.isEnabled.mockResolvedValueOnce(true);

    const res = await controller.getConfigSnapshotFlag();

    expect(res).toEqual({ enabled: true });
    expect(configSnapshotFlag.isEnabled).toHaveBeenCalledTimes(1);
    expect(configSnapshotFlag.setEnabled).not.toHaveBeenCalled();
  });

  it("GET does not mutate even across repeated calls", async () => {
    const { controller, configSnapshotFlag } = build();
    await controller.getConfigSnapshotFlag();
    await controller.getConfigSnapshotFlag();
    expect(configSnapshotFlag.setEnabled).not.toHaveBeenCalled();
  });

  it("PUT flips the flag and audits the actor + reason + previous value, regardless of the resulting value", async () => {
    const { controller, configSnapshotFlag, svc } = build();
    configSnapshotFlag.isEnabled.mockResolvedValueOnce(false); // the real, forced read

    const res = await controller.setConfigSnapshotFlag(
      { enabled: true, reason: "owner ruling 2026-09-23" },
      { sub: "admin-1" } as never,
    );

    expect(configSnapshotFlag.setEnabled).toHaveBeenCalledWith(true);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      null,
      "admin-1",
      AdminAuditAction.CONFIG_SNAPSHOT_FLAG_CHANGED,
      { previous: false, enabled: true, reason: "owner ruling 2026-09-23" },
    );
    expect(res).toEqual({ enabled: true });
  });

  it("PUT audits a flip to OFF the same as a flip to ON", async () => {
    const { controller, configSnapshotFlag, svc } = build();
    configSnapshotFlag.isEnabled.mockResolvedValueOnce(true);

    await controller.setConfigSnapshotFlag({ enabled: false, reason: "owner ruling 2026-09-23" }, {
      sub: "admin-1",
    } as never);

    expect(configSnapshotFlag.setEnabled).toHaveBeenCalledWith(false);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      null,
      "admin-1",
      AdminAuditAction.CONFIG_SNAPSHOT_FLAG_CHANGED,
      { previous: true, enabled: false, reason: "owner ruling 2026-09-23" },
    );
  });

  it("forces a real database read before recording `previous` — the cached value can be ~5 s stale", async () => {
    const { controller, configSnapshotFlag } = build();

    await controller.setConfigSnapshotFlag({ enabled: true, reason: "owner ruling 2026-09-23" }, {
      sub: "admin-1",
    } as never);

    // invalidate() then isEnabled(), and BOTH before setEnabled() — never after, which would
    // read back the value this same call just wrote.
    expect(configSnapshotFlag.invalidate).toHaveBeenCalledTimes(1);
    const invalidateOrder = configSnapshotFlag.invalidate.mock.invocationCallOrder[0];
    const isEnabledOrder = configSnapshotFlag.isEnabled.mock.invocationCallOrder[0];
    const setEnabledOrder = configSnapshotFlag.setEnabled.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(isEnabledOrder);
    expect(isEnabledOrder).toBeLessThan(setEnabledOrder);
  });

  it("a failed flag write is NOT audited as a success", async () => {
    const { controller, configSnapshotFlag, svc } = build();
    configSnapshotFlag.setEnabled.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      controller.setConfigSnapshotFlag({ enabled: true, reason: "owner ruling 2026-09-23" }, {
        sub: "admin-1",
      } as never),
    ).rejects.toThrow("db unavailable");
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });
});
