import { AdminAuditAction } from "./audit-actions.constant";
import { PlatformAdminController } from "./platform-admin.controller";

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
  );
  return { controller, snapshotAdmin, svc };
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
