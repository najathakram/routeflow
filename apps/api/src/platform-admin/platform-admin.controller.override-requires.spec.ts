/**
 * B524 — `PlatformAdminController#createFeatureOverride`'s requires-enforcement guard
 * (`assertOverrideRequirementsMet`). See that method's own doc comment for why this check
 * lives in the controller rather than inside `FeatureOverrideService.create` (a real circular
 * DI edge — `feature-override-single-caller.spec.ts` in `apps/api/src/billing/` is the static
 * guard that keeps the "one caller" premise this relies on true).
 *
 * Deliberately does NOT instantiate the whole controller test suite (none exists for this file
 * — it has nine injected services and dozens of routes) — only the handful of dependencies this
 * one guard touches are given real jest.fn() behavior; everything else is a bare stub the code
 * path under test never calls.
 */
import { BadRequestException } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller";

function stub() {
  return new Proxy(
    {},
    {
      get: () => jest.fn(),
    },
  );
}

function make(opts: { effectiveKeys?: string[] | null; recordAdminAction?: jest.Mock } = {}) {
  const resolvedValue =
    opts.effectiveKeys === null
      ? null
      : { byKey: new Map((opts.effectiveKeys ?? []).map((k) => [k, { key: k, effective: true }])) };

  const authority = { resolveAll: jest.fn().mockResolvedValue(resolvedValue) };
  const featureOverrides = { create: jest.fn().mockResolvedValue({ kind: "COMP" }) };
  const svc = {
    recordAdminAction: opts.recordAdminAction ?? jest.fn().mockResolvedValue(undefined),
  };

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

describe("B524 — PlatformAdminController#createFeatureOverride requires guard", () => {
  it("400s a GRANT whose requires is unmet, writes nothing, and never calls recordAdminAction", async () => {
    const { controller, featureOverrides, svc } = make({ effectiveKeys: [] });
    const dto = {
      featureKey: "driver_payments",
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await expect(controller.createFeatureOverride("t1", dto as any, admin)).rejects.toThrow(
      BadRequestException,
    );
    expect(featureOverrides.create).not.toHaveBeenCalled();
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it("proceeds when the GRANT's requires IS met", async () => {
    const { controller, featureOverrides } = make({ effectiveKeys: ["recurring_routes"] });
    const dto = {
      featureKey: "driver_payments",
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: "driver_payments", effect: "GRANT" }),
    );
  });

  it("proceeds on an unmet GRANT when acknowledgeUnmetRequires is true, and never resolves effective keys", async () => {
    const { controller, featureOverrides, authority } = make({ effectiveKeys: [] });
    const dto = {
      featureKey: "driver_payments",
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
      acknowledgeUnmetRequires: true,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalled();
    expect(authority.resolveAll).not.toHaveBeenCalled();
  });

  it("a DENY is never checked against requires regardless of ack, even with an unmet prerequisite", async () => {
    const { controller, featureOverrides, authority } = make({ effectiveKeys: [] });
    const dto = {
      featureKey: "driver_payments",
      effect: "DENY" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalled();
    expect(authority.resolveAll).not.toHaveBeenCalled();
  });

  it("a featureKey with no registry entry is a no-op passthrough", async () => {
    const { controller, featureOverrides, authority } = make({ effectiveKeys: [] });
    const dto = {
      featureKey: "not_a_real_registry_key",
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalled();
    expect(authority.resolveAll).not.toHaveBeenCalled();
  });

  it("a registered key with no requires is a no-op passthrough", async () => {
    const { controller, featureOverrides, authority } = make({ effectiveKeys: [] });
    const dto = {
      featureKey: "msrp", // registered, no `requires`
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalled();
    expect(authority.resolveAll).not.toHaveBeenCalled();
  });

  it("proceeds (fails open) when authority.resolveAll returns null — a separate, already-surfaced failure mode", async () => {
    const { controller, featureOverrides } = make({ effectiveKeys: null });
    const dto = {
      featureKey: "driver_payments",
      effect: "GRANT" as const,
      reason: "test",
      expiresAt: undefined,
    };

    await controller.createFeatureOverride("t1", dto as any, admin);
    expect(featureOverrides.create).toHaveBeenCalled();
  });
});
