/**
 * B524 — `PlatformAdminController#createFeatureOverride`/`#revokeFeatureOverride`'s
 * requires-enforcement + resolver-cache-invalidation guards. See `createFeatureOverride`'s own
 * doc comment for why the check calls `EntitlementAuthority.assertFeatureRequiresMet` (shared
 * with `AddonService.enableAddon`) rather than living inside `FeatureOverrideService.create`
 * itself (a real circular DI edge) — `feature-override-single-caller.spec.ts` in
 * `apps/api/src/billing/` is the static guard that keeps the "one caller" premise this relies
 * on true. The requires LOGIC itself (allOf/anyOf, fail-open, the ack short-circuit) is tested
 * once, directly, in `entitlement-authority.requires.spec.ts` — this suite only proves the
 * controller calls that shared check with the right args and reacts correctly to it.
 *
 * Deliberately does NOT instantiate the whole controller test suite (none exists for this file
 * — it has nine injected services and dozens of routes) — only the handful of dependencies this
 * guard touches are given real jest.fn() behavior; everything else is a bare stub the code
 * path under test never calls.
 */
import { BadRequestException } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller";

function stub() {
  return new Proxy({}, { get: () => jest.fn() });
}

function make(opts: { assertFeatureRequiresMet?: jest.Mock } = {}) {
  const authority = {
    assertFeatureRequiresMet:
      opts.assertFeatureRequiresMet ?? jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(),
  };
  const featureOverrides = {
    create: jest.fn().mockResolvedValue({ kind: "COMP" }),
    revoke: jest.fn().mockResolvedValue({ id: "ov-1" }),
  };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };

  const controller = new PlatformAdminController(
    svc as any,
    stub() as any, // platformConfig
    stub() as any, // billingService
    stub() as any, // addonService
    featureOverrides as any,
    stub() as any, // entitlementsMode
    stub() as any, // featureDiffs
    authority as any,
    stub() as any, // featurePreview
  );
  return { controller, authority, featureOverrides, svc };
}

const admin = { sub: "admin-1" } as any;
const baseDto = { featureKey: "driver_payments", reason: "test", expiresAt: undefined };

describe("B524 — PlatformAdminController#createFeatureOverride requires guard", () => {
  it("calls authority.assertFeatureRequiresMet with (tenantId, featureKey, ack) for a GRANT", async () => {
    const { controller, authority } = make();
    const dto = { ...baseDto, effect: "GRANT" as const, acknowledgeUnmetRequires: true };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(authority.assertFeatureRequiresMet).toHaveBeenCalledWith("t1", "driver_payments", true);
  });

  it("never calls the check for a DENY, even with an explicit ack value", async () => {
    const { controller, authority, featureOverrides } = make();
    const dto = { ...baseDto, effect: "DENY" as const };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(authority.assertFeatureRequiresMet).not.toHaveBeenCalled();
    expect(featureOverrides.create).toHaveBeenCalled();
  });

  it("propagates the shared check's rejection, writes nothing, and never audits", async () => {
    const rejecting = jest.fn().mockRejectedValue(new BadRequestException("depends on X"));
    const { controller, featureOverrides, svc } = make({ assertFeatureRequiresMet: rejecting });
    const dto = { ...baseDto, effect: "GRANT" as const };
    await expect(controller.createFeatureOverride("t1", dto as any, admin)).rejects.toThrow(
      BadRequestException,
    );
    expect(featureOverrides.create).not.toHaveBeenCalled();
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it("proceeds and writes when the shared check resolves", async () => {
    const { controller, featureOverrides } = make();
    const dto = { ...baseDto, effect: "GRANT" as const };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: "driver_payments", effect: "GRANT" }),
    );
  });

  // F1 (Opus review): a GRANT must invalidate the resolver cache so it's visible to the very
  // next requires check, not up to 30s later.
  it("invalidates the resolver cache after a successful create", async () => {
    const { controller, authority } = make();
    const dto = { ...baseDto, effect: "GRANT" as const };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(authority.invalidate).toHaveBeenCalledWith("t1");
  });

  it("does NOT invalidate the resolver cache when the check rejects (nothing was written)", async () => {
    const rejecting = jest.fn().mockRejectedValue(new BadRequestException("depends on X"));
    const { controller, authority } = make({ assertFeatureRequiresMet: rejecting });
    const dto = { ...baseDto, effect: "GRANT" as const };
    await expect(controller.createFeatureOverride("t1", dto as any, admin)).rejects.toThrow();
    expect(authority.invalidate).not.toHaveBeenCalled();
  });

  // F6 (Opus review): the audit trail must show whether an admin knowingly overrode the check.
  it("audits acknowledgeUnmetRequires (true when the DTO sets it)", async () => {
    const { controller, svc } = make();
    const dto = { ...baseDto, effect: "GRANT" as const, acknowledgeUnmetRequires: true };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      "t1",
      "admin-1",
      expect.anything(),
      expect.objectContaining({ acknowledgeUnmetRequires: true }),
    );
  });

  it("audits acknowledgeUnmetRequires as false when the DTO omits it", async () => {
    const { controller, svc } = make();
    const dto = { ...baseDto, effect: "GRANT" as const };
    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      "t1",
      "admin-1",
      expect.anything(),
      expect.objectContaining({ acknowledgeUnmetRequires: false }),
    );
  });
});

describe("B524 — PlatformAdminController#revokeFeatureOverride resolver-cache invalidation", () => {
  it("invalidates the resolver cache after a revoke (F1 — the same staleness in the other direction)", async () => {
    const { controller, authority } = make();
    await controller.revokeFeatureOverride("t1", "ov-1", admin);
    expect(authority.invalidate).toHaveBeenCalledWith("t1");
  });
});
