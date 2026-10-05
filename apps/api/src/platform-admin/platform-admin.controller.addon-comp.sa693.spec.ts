/**
 * SA-693 — the platform-admin add-on routes carry the explicit `comp` choice and audit it:
 * enable with `comp: true` -> addonService.enableAddon(..., { comp: true }) + an ADDON_COMPED
 * AuditLog row (actor + optional reason); uncomp -> ADDON_UNCOMPED. The money behaviour itself
 * (no Stripe item, price 0, never silently billing) is pinned in billing/addon.comp.sa693.spec.ts.
 */
import { PlatformAdminController } from "./platform-admin.controller";
import { AdminAuditAction, ADMIN_AUDIT_ACTION_LABELS } from "./audit-actions.constant";

function stub() {
  return new Proxy({}, { get: () => jest.fn() });
}

function make() {
  const addonService = {
    enableAddon: jest.fn().mockResolvedValue({ id: "a1" }),
    uncompAddon: jest.fn().mockResolvedValue({ id: "a1" }),
  };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const controller = new PlatformAdminController(
    svc as any,
    stub() as any,
    stub() as any,
    addonService as any,
    stub() as any,
    stub() as any,
    stub() as any,
    stub() as any,
    stub() as any,
    stub() as any,
    stub() as any,
  );
  return { controller, addonService, svc };
}

const admin = { sub: "admin-1" } as any;

describe("SA-693 audit codes", () => {
  it("ADDON_COMPED / ADDON_UNCOMPED are declared and labelled", () => {
    expect(AdminAuditAction.ADDON_COMPED).toBe("ADDON_COMPED");
    expect(AdminAuditAction.ADDON_UNCOMPED).toBe("ADDON_UNCOMPED");
    expect(ADMIN_AUDIT_ACTION_LABELS.ADDON_COMPED).toBeTruthy();
    expect(ADMIN_AUDIT_ACTION_LABELS.ADDON_UNCOMPED).toBeTruthy();
  });
});

describe("SA-693 PlatformAdminController#enableAddon", () => {
  it("comp: true passes the flag down and writes ADDON_COMPED with the actor and the reason", async () => {
    const { controller, addonService, svc } = make();

    await controller.enableAddon(
      "t1",
      { addonKey: "tobacco_dealer", comp: true, reason: "pilot partner" } as any,
      admin,
    );

    expect(addonService.enableAddon).toHaveBeenCalledWith(
      "t1",
      "tobacco_dealer",
      undefined,
      undefined,
      { comp: true },
    );
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      "t1",
      "admin-1",
      AdminAuditAction.ADDON_COMPED,
      expect.objectContaining({ addonKey: "tobacco_dealer", reason: "pilot partner" }),
    );
  });

  it("without comp it is a plain billed/free enable: comp false, and NO ADDON_COMPED row", async () => {
    const { controller, addonService, svc } = make();

    await controller.enableAddon(
      "t1",
      { addonKey: "tobacco_dealer", stripePriceId: "price_1" } as any,
      admin,
    );

    expect(addonService.enableAddon).toHaveBeenCalledWith(
      "t1",
      "tobacco_dealer",
      "price_1",
      undefined,
      { comp: false },
    );
    const actions = svc.recordAdminAction.mock.calls.map((c: any[]) => c[2]);
    expect(actions).toEqual([AdminAuditAction.ADDON_ENABLED]);
  });
});

describe("SA-693 PlatformAdminController#uncompAddon", () => {
  it("calls the service and writes ADDON_UNCOMPED with the actor", async () => {
    const { controller, addonService, svc } = make();

    await controller.uncompAddon(
      "t1",
      { addonKey: "tobacco_dealer", stripePriceId: "price_1", reason: "now paying" } as any,
      admin,
    );

    expect(addonService.uncompAddon).toHaveBeenCalledWith("t1", "tobacco_dealer", "price_1");
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      "t1",
      "admin-1",
      AdminAuditAction.ADDON_UNCOMPED,
      expect.objectContaining({ addonKey: "tobacco_dealer", reason: "now paying" }),
    );
  });

  it("a refused uncomp (service throws) writes no audit row", async () => {
    const { controller, addonService, svc } = make();
    addonService.uncompAddon.mockRejectedValue(new Error("refused"));

    await expect(controller.uncompAddon("t1", { addonKey: "x" } as any, admin)).rejects.toThrow();

    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });
});
