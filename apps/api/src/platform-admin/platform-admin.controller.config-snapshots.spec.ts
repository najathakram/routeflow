import { ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { PlatformAdminController } from "./platform-admin.controller";

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
