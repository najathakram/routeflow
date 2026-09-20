import { AdminAuditAction } from "./audit-actions.constant";
import { CONFIG_SNAPSHOT_RESTORED_ACTION } from "../billing/config-snapshot-audit.constants";
import { ADMIN_AUDIT_ACTION_LABELS } from "./audit-actions.constant";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PlatformAdminController } from "./platform-admin.controller";
import { SetConfigSnapshotFlagDto } from "./dto/set-config-snapshot-flag.dto";

// Lane B A2 step c — the controller only routes + audits; the rules live in
// TenantConfigSnapshotAdminService (its own spec). SuperAdminGuard is class-level.
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
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const snapshotFlag = {
    isEnabled: jest.fn().mockResolvedValue(false),
    setEnabled: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new PlatformAdminController(
    svc as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    snapshotAdmin as never,
    snapshotFlag as never,
  );
  return { controller, snapshotAdmin, svc, snapshotFlag };
}

describe("PlatformAdminController — config snapshots", () => {
  it("lists and previews by tenant + snapshot id", async () => {
    const { controller, snapshotAdmin } = build();
    await controller.listConfigSnapshots("t1");
    await controller.previewConfigSnapshotRestore("t1", "s1");
    expect(snapshotAdmin.list).toHaveBeenCalledWith("t1");
    expect(snapshotAdmin.preview).toHaveBeenCalledWith("t1", "s1");
  });

  it("Restore Now audits the acting admin against the target tenant, with the report", async () => {
    const { controller, snapshotAdmin, svc } = build();

    const res = await controller.restoreConfigSnapshot("t1", "s1", { sub: "admin-1" } as never);

    expect(snapshotAdmin.restoreNow).toHaveBeenCalledWith("t1", "s1");
    expect(res).toMatchObject({ snapshotId: "s1" });
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      "t1",
      "admin-1",
      AdminAuditAction.CONFIG_SNAPSHOT_RESTORED,
      expect.objectContaining({
        snapshotId: "s1",
        snapshotPlanKey: "SCALE",
        restoredToPlanKey: "SCALE",
        report: { restored: 2, skipped: 0, keptNewer: 1, unchanged: 0 },
      }),
    );
  });

  it("a failed restore is NOT audited as a success", async () => {
    const { controller, snapshotAdmin, svc } = build();
    snapshotAdmin.restoreNow.mockRejectedValueOnce(new Error("409"));

    await expect(
      controller.restoreConfigSnapshot("t1", "s1", { sub: "admin-1" } as never),
    ).rejects.toThrow("409");
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });
});

describe("PlatformAdminController — config snapshot live flag (A2 decision 2)", () => {
  it("GET reports the current state", async () => {
    const { controller, snapshotFlag } = build();
    snapshotFlag.isEnabled.mockResolvedValueOnce(true);
    expect(await controller.getConfigSnapshotFlag()).toEqual({ enabled: true });
  });

  it("PUT switches it and audits the acting admin with the reason (platform-wide: no tenant)", async () => {
    const { controller, snapshotFlag, svc } = build();

    const res = await controller.setConfigSnapshotFlag(
      { enabled: true, reason: "pilot on the test tenant" },
      { sub: "admin-1" } as never,
    );

    expect(res).toEqual({ enabled: true });
    expect(snapshotFlag.setEnabled).toHaveBeenCalledWith(true);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      null,
      "admin-1",
      AdminAuditAction.CONFIG_SNAPSHOT_FLAG_CHANGED,
      { enabled: true, reason: "pilot on the test tenant" },
    );
  });

  it("a failed write is not audited as a change", async () => {
    const { controller, snapshotFlag, svc } = build();
    snapshotFlag.setEnabled.mockRejectedValueOnce(new Error("db"));

    await expect(
      controller.setConfigSnapshotFlag({ enabled: true, reason: "why" }, { sub: "a" } as never),
    ).rejects.toThrow("db");
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });
});

describe("SetConfigSnapshotFlagDto validation (the real pipe rules: whitelist + transform)", () => {
  const check = async (body: object) => {
    const dto = plainToInstance(SetConfigSnapshotFlagDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  };

  it("accepts a real boolean and a reason", async () => {
    expect(await check({ enabled: true, reason: "pilot" })).toHaveLength(0);
  });

  it("the STRING 'false' is rejected — it can never become truthy", async () => {
    expect((await check({ enabled: "false", reason: "pilot" })).length).toBeGreaterThan(0);
  });

  it("a blank reason (spaces only) is rejected after trimming", async () => {
    expect((await check({ enabled: true, reason: "     " })).length).toBeGreaterThan(0);
  });

  it("an unknown property is rejected", async () => {
    expect((await check({ enabled: true, reason: "pilot", force: true })).length).toBeGreaterThan(
      0,
    );
  });
});

describe("the restore audit action is ONE string on both write paths", () => {
  it("the automatic restore (billing) and the manual Restore now (platform-admin) write the same action", () => {
    expect(CONFIG_SNAPSHOT_RESTORED_ACTION).toBe(AdminAuditAction.CONFIG_SNAPSHOT_RESTORED);
  });

  it("both snapshot actions are registered with a label (they appear in the audit-log filter)", () => {
    expect(ADMIN_AUDIT_ACTION_LABELS.CONFIG_SNAPSHOT_RESTORED).toBeTruthy();
    expect(ADMIN_AUDIT_ACTION_LABELS.CONFIG_SNAPSHOT_FLAG_CHANGED).toBeTruthy();
  });
});
