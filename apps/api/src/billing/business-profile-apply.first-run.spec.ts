/**
 * W1 (F20, F20b): a back-office apply takes the first question away, and the marker is never created or overwritten.
 * The apply sequence itself is covered by the platform-admin controller specs; here only the close is under test.
 */
import { BusinessProfileApplyService, type ApplyIo } from "./business-profile-apply.service";
import { FIRST_RUN_KEY, closeFirstRun } from "./first-run-marker";

const T = "tenant-1";
const plan = { billing: [], overrides: [], comps: [], modes: [] };
const resolved = {
  profile: { key: "custom" },
  plan,
  revokeOverrideIds: {},
  previewRequest: {},
  summary: [],
  reason: "r",
  capabilities: {},
  preset: null,
  blocked: null,
} as never;

function build(updateMany: jest.Mock) {
  const prisma = { systemConfig: { updateMany, create: jest.fn(), upsert: jest.fn() } };
  const svc = new BusinessProfileApplyService(
    {} as never,
    { invalidate: jest.fn() } as never,
    { set: jest.fn() } as never,
    { preview: jest.fn().mockResolvedValue({ changed: [] }) } as never,
    { assertNotBlocked: jest.fn(), assertPlanUnchanged: jest.fn() } as never,
    prisma as never,
  );
  const io: ApplyIo = {
    disableAddon: jest.fn(),
    createOverride: jest.fn(),
    revokeOverride: jest.fn(),
    audit: jest.fn().mockResolvedValue(undefined),
  };
  return { svc, io, prisma };
}

const dto = { planFingerprint: "x" };
const admin = { id: "a1", kind: "PLATFORM_ADMIN", source: "profile.apply" } as const;
const tenant = { id: "u1", kind: "TENANT_USER", source: "signup.setup" } as const;

describe("a back-office apply and the first-question marker", () => {
  it("F20: moves a pending marker to closed, by update only and only while it is pending", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { svc, io, prisma } = build(updateMany);
    await svc.applyResolvedLocked(T, resolved, dto, admin, io);
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: T, key: FIRST_RUN_KEY, value: "pending" },
      data: { value: "closed" },
    });
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
  });

  it("F20b: on a tenant with no marker nothing matches, so nothing is written (and no row is created)", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { svc, io, prisma } = build(updateMany);
    await svc.applyResolvedLocked(T, resolved, dto, admin, io);
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
  });

  it("a failed close does not fail the apply", async () => {
    const updateMany = jest.fn().mockRejectedValue(new Error("db down"));
    const { svc, io } = build(updateMany);
    await expect(svc.applyResolvedLocked(T, resolved, dto, admin, io)).resolves.toMatchObject({
      plan,
    });
  });

  it("the tenant's own answer does not close it here: the first-question service closes it as answered, last", async () => {
    const updateMany = jest.fn();
    const { svc, io } = build(updateMany);
    await svc.applyResolvedLocked(T, resolved, dto, tenant, io);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("the close helper never moves a marker that is not pending", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const moved = await closeFirstRun({ systemConfig: { updateMany } } as never, T, "answered");
    expect(moved).toBe(false);
    expect(updateMany.mock.calls[0][0].where.value).toBe("pending");
  });
});
