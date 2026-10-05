/**
 * Business profiles — the platform-admin routes. Red-first: written before the routes existed.
 *
 * The confirm path is the EXISTING one: the controller's own `createFeatureOverride` /
 * `revokeFeatureOverride` (requires check + FEATURE_OVERRIDE_* audit each) and
 * `FeatureConfigService.set` (fleet 409 + FEATURE_CONFIG_SET audit), then ONE
 * BUSINESS_PROFILE_APPLIED audit row. Nothing here writes a config row directly.
 *
 * The fake tenant below is an in-memory model of the saved state the real services enforce:
 * `set()` refuses delivery/both unless a fleet key is held IN THE SAVED STATE (SA note on
 * feature-config.service.ts ~:192), and `create()` refuses a second active override on a key
 * (the partial unique index). Both profile transitions must land whole under those rules.
 */
import "reflect-metadata";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { PlatformAdminController } from "./platform-admin.controller";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { BusinessProfileService } from "../billing/business-profile.service";
import { AdminAuditAction } from "./audit-actions.constant";

const T = "tenant-a";
const FLEET = ["recurring_routes", "order_delivery"];

interface Row {
  id: string;
  tenantId: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/** The saved state of one tenant, plus the ordered log of every write that reached it. */
function fakeTenant(start: {
  overrides?: Record<string, "GRANT" | "DENY">;
  /** Add-on rows the tenant PAYS for (a Stripe item / a price). */
  addons?: string[];
  /** Comped add-on rows (no Stripe item, no price) — held, but not paid for. */
  comped?: string[];
  /** The add-on whose (existing) disable fails, e.g. Stripe unavailable. */
  disableFails?: string;
  modes?: Record<string, string>;
}) {
  let seq = 0;
  const rows: Row[] = Object.entries(start.overrides ?? {}).map(([featureKey, effect]) => ({
    id: `seed-${++seq}`,
    tenantId: T,
    featureKey,
    effect,
    revokedAt: null,
    expiresAt: null,
  }));
  const addons = new Set([...(start.addons ?? []), ...(start.comped ?? [])]);
  const failing = { key: start.disableFails as string | undefined };
  const paid = new Set(start.addons ?? []);
  const modes: Record<string, string> = {
    fulfilment_model: "unset",
    counter_sales: "unset",
    ...start.modes,
  };
  const writes: string[] = [];
  const active = (key: string) => rows.find((r) => r.featureKey === key && !r.revokedAt);
  const can = (key: string) => {
    const ov = active(key);
    if (ov) return ov.effect === "GRANT";
    // driver-payments.guard.ts: no override → an add-on row or 403 (NOT on by default, SA-671 M2)
    return addons.has(key);
  };

  const featureOverrides = {
    list: jest.fn(async (tenantId: string) => rows.filter((r) => r.tenantId === tenantId)),
    allActive: jest.fn(
      async () =>
        new Map(rows.filter((r) => !r.revokedAt).map((r) => [r.featureKey, r.effect] as const)),
    ),
    create: jest.fn(
      async (p: { tenantId: string; featureKey: string; effect: "GRANT" | "DENY" }) => {
        if (active(p.featureKey)) throw new ConflictException("active override exists");
        const row = { id: `ov-${++seq}`, revokedAt: null, expiresAt: null, ...p } as Row;
        rows.push(row);
        writes.push(`override ${p.effect} ${p.featureKey}`);
        return { ...row, kind: "COMP" };
      },
    ),
    revoke: jest.fn(async (_t: string, id: string) => {
      const row = rows.find((r) => r.id === id)!;
      row.revokedAt = new Date();
      writes.push(`revoke ${row.effect} ${row.featureKey}`);
      return row;
    }),
  };
  const addonService = {
    getActiveAddons: jest.fn(async () => [...addons]),
    // The EXISTING disable (Stripe item removal + the locked ledger update) — modelled here.
    disableAddon: jest.fn(async (_t: string, key: string) => {
      if (key === failing.key) {
        throw new ServiceUnavailableException(`Could not remove the Stripe item for "${key}"`);
      }
      addons.delete(key);
      paid.delete(key);
      writes.push(`disable ${key}`);
      return { addonKey: key, active: false };
    }),
  };
  const featureConfig = {
    getState: jest.fn(async (_t: string, key: string) => ({
      value: modes[key],
      effective: modes[key],
    })),
    set: jest.fn(async (_t: string, key: string, mode: string) => {
      if (key === "fulfilment_model" && (mode === "delivery" || mode === "both")) {
        if (!FLEET.some(can)) {
          throw new ConflictException({ code: "FULFILMENT_MODE_NEEDS_FLEET", key, mode });
        }
      }
      modes[key] = mode;
      writes.push(`mode ${key}=${mode}`);
    }),
  };
  const authority = {
    // B524: a GRANT of driver_payments needs a fleet key in the SAVED state.
    assertFeatureRequiresMet: jest.fn(async (_t: string, key: string) => {
      if (key === "driver_payments" && !FLEET.some(can)) {
        throw new ConflictException({ code: "FEATURE_REQUIRES_UNMET" });
      }
    }),
    invalidate: jest.fn(),
  };
  const featurePreview = {
    preview: jest.fn(async () => ({ before: [], after: [], changed: ["fleet-change"] })),
  };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ id: T }) },
    tenantAddon: {
      findFirst: jest.fn(async ({ where }: any) => {
        const key = where.OR[0].addonKey;
        if (!addons.has(key)) return null;
        const isPaid = paid.has(key);
        return {
          addonKey: key,
          active: true,
          stripeItemId: isPaid ? "si_x" : null,
          priceSnapshot: isPaid ? "49.00" : null,
        };
      }),
    },
  };
  const businessProfiles = new BusinessProfileService(
    prisma as never,
    featureOverrides as never,
    addonService as never,
    featureConfig as never,
    featurePreview as never,
  );
  const stub = () => ({});
  const controller = new PlatformAdminController(
    svc as any,
    stub() as any, // platformConfig
    stub() as any, // billingService
    addonService as any,
    featureOverrides as any,
    stub() as any, // entitlementsMode
    stub() as any, // configSnapshotFlag
    stub() as any, // featureDiffs
    authority as any,
    featurePreview as any,
    stub() as any, // snapshotAdmin
    businessProfiles,
    featureConfig as any,
  );
  const state = () => ({
    modes: { ...modes },
    held: Object.fromEntries(
      ["recurring_routes", "order_delivery", "driver_payments"].map((k) => [k, can(k)]),
    ),
    activeOverrides: rows.filter((r) => !r.revokedAt).length,
  });
  return {
    failNoMore: () => {
      failing.key = undefined;
    },
    controller,
    svc,
    featureOverrides,
    featureConfig,
    authority,
    addonService,
    writes,
    state,
  };
}

const admin = { sub: "admin-1", role: UserRole.SUPER_ADMIN } as any;

describe("business-profile routes are platform-admin only", () => {
  it("the controller carries SuperAdminGuard, and that guard refuses every tenant role", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PlatformAdminController) as unknown[];
    expect(guards).toContain(SuperAdminGuard);
    const guard = new SuperAdminGuard();
    const ctx = (role: UserRole) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: { role, tenantId: T } }) }) }) as any;
    for (const role of [
      UserRole.TENANT_ADMIN,
      UserRole.OPERATOR,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ]) {
      expect(guard.canActivate(ctx(role))).toBe(false);
    }
    expect(guard.canActivate(ctx(UserRole.SUPER_ADMIN))).toBe(true);
  });

  it("the three routes exist on that controller", () => {
    const proto = PlatformAdminController.prototype as any;
    expect(typeof proto.listBusinessProfiles).toBe("function");
    expect(typeof proto.previewBusinessProfile).toBe("function");
    expect(typeof proto.applyBusinessProfile).toBe("function");
  });
});

describe("GET business-profiles / POST preview", () => {
  it("lists the four profiles", () => {
    const { controller } = fakeTenant({});
    expect(controller.listBusinessProfiles().profiles).toHaveLength(4);
  });

  it("preview writes nothing", async () => {
    const { controller, writes } = fakeTenant({});
    const res = await controller.previewBusinessProfile(T, { profile: "delivery_distributor" });
    expect(res.profile).toBe("delivery_distributor");
    expect(res.summary.length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
  });
});

describe("POST business-profile (confirm) — through the existing audited writes", () => {
  it("unset tenant → delivery distributor: fleet grants land BEFORE the delivery mode; one profile audit row", async () => {
    const t = fakeTenant({});
    const res = await t.controller.applyBusinessProfile(
      T,
      { profile: "delivery_distributor" },
      admin,
    );
    expect(t.writes).toEqual([
      "override GRANT recurring_routes",
      "override GRANT order_delivery",
      "override GRANT driver_payments", // M2: not on by default, so the profile turns it on
      "mode fulfilment_model=delivery",
    ]);
    expect(t.state().modes.fulfilment_model).toBe("delivery");
    // every override write went through the controller's own audited path
    expect(t.svc.recordAdminAction).toHaveBeenCalledWith(
      T,
      "admin-1",
      AdminAuditAction.FEATURE_OVERRIDE_SET,
      expect.objectContaining({ featureKey: "recurring_routes", effect: "GRANT" }),
    );
    expect(t.featureConfig.set).toHaveBeenCalledWith(
      T,
      "fulfilment_model",
      "delivery",
      "Business profile: Delivery distributor",
      "admin-1",
    );
    const profileRows = t.svc.recordAdminAction.mock.calls.filter(
      (c: unknown[]) => c[2] === AdminAuditAction.BUSINESS_PROFILE_APPLIED,
    );
    expect(profileRows).toEqual([
      [
        T,
        "admin-1",
        AdminAuditAction.BUSINESS_PROFILE_APPLIED,
        expect.objectContaining({
          profile: "delivery_distributor",
          reason: "Business profile: Delivery distributor",
        }),
      ],
    ]);
    expect(res).toMatchObject({ profile: "delivery_distributor", changed: ["fleet-change"] });
  });

  it("Delivery distributor → Shipping wholesaler: the mode moves to ship BEFORE the fleet is denied — lands whole", async () => {
    const t = fakeTenant({
      overrides: { recurring_routes: "GRANT", order_delivery: "GRANT", driver_payments: "GRANT" },
      modes: { fulfilment_model: "delivery" },
    });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.writes).toEqual([
      "mode fulfilment_model=ship",
      "revoke GRANT recurring_routes",
      "override DENY recurring_routes",
      "revoke GRANT order_delivery",
      "override DENY order_delivery",
      "revoke GRANT driver_payments",
      "override DENY driver_payments",
    ]);
    expect(t.state()).toEqual({
      modes: { fulfilment_model: "ship", counter_sales: "unset" },
      held: { recurring_routes: false, order_delivery: false, driver_payments: false },
      activeOverrides: 3,
    });
  });

  it("Shipping wholesaler → Delivery distributor: the fleet is granted BEFORE the delivery mode — no 409, lands whole", async () => {
    const t = fakeTenant({
      overrides: { recurring_routes: "DENY", order_delivery: "DENY", driver_payments: "DENY" },
      modes: { fulfilment_model: "ship" },
    });
    await t.controller.applyBusinessProfile(T, { profile: "delivery_distributor" }, admin);
    expect(t.writes).toEqual([
      "revoke DENY recurring_routes",
      "override GRANT recurring_routes",
      "revoke DENY order_delivery",
      "override GRANT order_delivery",
      "revoke DENY driver_payments",
      "override GRANT driver_payments",
      "mode fulfilment_model=delivery",
    ]);
    expect(t.state()).toEqual({
      modes: { fulfilment_model: "delivery", counter_sales: "unset" },
      held: { recurring_routes: true, order_delivery: true, driver_payments: true },
      activeOverrides: 3,
    });
  });

  it("re-applying the same profile is idempotent: no writes, still one audit row", async () => {
    const t = fakeTenant({ comped: ["order_delivery"] });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    const first = [...t.writes];
    t.writes.length = 0;
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(first).toEqual(["mode fulfilment_model=ship", "override DENY order_delivery"]);
    expect(t.writes).toEqual([]);
  });

  it.each(["in_store_retailer", "in_store_shipping_retailer"])(
    "SA-671 M1: %s is refused with BUSINESS_PROFILE_UNAVAILABLE before ANY write",
    async (profile) => {
      const t = fakeTenant({ addons: ["recurring_routes"] });
      const err = await t.controller
        .applyBusinessProfile(T, { profile: profile as never }, admin)
        .catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNAVAILABLE" });
      expect(t.writes).toEqual([]);
      expect(t.svc.recordAdminAction).not.toHaveBeenCalled();
    },
  );

  it("SA-671 M1 bypass: a tenant ALREADY stored in-store is still refused — no counter_sales, no DENYs", async () => {
    const t = fakeTenant({
      addons: ["recurring_routes"],
      modes: { fulfilment_model: "pickup", counter_sales: "unset" },
    });
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "in_store_retailer" }, admin)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNAVAILABLE" });
    expect(t.writes).toEqual([]);
  });

  it("an unknown profile is refused before ANY write", async () => {
    const t = fakeTenant({});
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "pickup_counter" as never }, admin)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNKNOWN" });
    expect(t.writes).toEqual([]);
    expect(t.svc.recordAdminAction).not.toHaveBeenCalled();
  });

  it("a caller-supplied reason is used on every audit row", async () => {
    const t = fakeTenant({});
    await t.controller.applyBusinessProfile(
      T,
      { profile: "shipping_wholesaler", reason: "onboarding call" },
      admin,
    );
    expect(t.featureConfig.set).toHaveBeenCalledWith(
      T,
      "fulfilment_model",
      "ship",
      "onboarding call",
      "admin-1",
    );
  });

  it("is tenant-scoped: every write names the :id tenant", async () => {
    const t = fakeTenant({});
    await t.controller.applyBusinessProfile(T, { profile: "delivery_distributor" }, admin);
    for (const c of t.featureOverrides.create.mock.calls) expect(c[0].tenantId).toBe(T);
    for (const c of t.featureConfig.set.mock.calls) expect(c[0]).toBe(T);
  });
});

describe("OWNER RULING (money, tier 1): switching OFF a module the tenant PAYS for stops its billing", () => {
  const audits = (t: ReturnType<typeof fakeTenant>, action: string) =>
    t.svc.recordAdminAction.mock.calls.filter((c: unknown[]) => c[2] === action);

  it("a paying tenant: the EXISTING add-on disable is called once per paid module, FIRST, in reverse dependency order, each audited", async () => {
    const t = fakeTenant({
      addons: ["recurring_routes", "order_delivery"],
      overrides: { driver_payments: "GRANT" },
      modes: { fulfilment_model: "delivery" },
    });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.addonService.disableAddon.mock.calls).toEqual([
      [T, "order_delivery"],
      [T, "recurring_routes"],
    ]);
    expect(t.writes).toEqual([
      "disable order_delivery",
      "disable recurring_routes",
      "mode fulfilment_model=ship",
      "revoke GRANT driver_payments",
      "override DENY driver_payments",
    ]);
    expect(audits(t, AdminAuditAction.ADDON_DISABLED).map((c) => c[3])).toEqual([
      { addonKey: "order_delivery" },
      { addonKey: "recurring_routes" },
    ]);
    expect(t.state().held).toEqual({
      recurring_routes: false,
      order_delivery: false,
      driver_payments: false,
    });
  });

  it("a free/comped add-on row: NO billing call — the module is switched off with a DENY override", async () => {
    const t = fakeTenant({ comped: ["recurring_routes"] });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
    expect(t.writes).toEqual(["mode fulfilment_model=ship", "override DENY recurring_routes"]);
  });

  it("a comp via GRANT override: NO billing call", async () => {
    const t = fakeTenant({ overrides: { order_delivery: "GRANT" } });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
  });

  it("the disable fails: the WHOLE apply is refused with a fixed code and nothing is applied", async () => {
    const t = fakeTenant({
      addons: ["recurring_routes"],
      overrides: { driver_payments: "GRANT" },
      modes: { fulfilment_model: "delivery" },
      disableFails: "recurring_routes",
    });
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
      .catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({
      code: "BUSINESS_PROFILE_BILLING_FAILED",
      featureKey: "recurring_routes",
      alreadyDisabled: [],
    });
    expect(t.writes).toEqual([]); // no mode, no override, no DENY
    expect(t.state().modes.fulfilment_model).toBe("delivery");
    expect(audits(t, AdminAuditAction.BUSINESS_PROFILE_APPLIED)).toEqual([]);
  });

  describe("LEAD RULING (all-or-nothing as far as Stripe allows): a disable fails at EACH step — the tenant is left in a VALID configuration", () => {
    /** Valid = no delivery-family mode without a fleet key; driver payments never without one. */
    const isValid = (st: ReturnType<ReturnType<typeof fakeTenant>["state"]>) => {
      const fleet = st.held.recurring_routes || st.held.order_delivery;
      const mode = st.modes.fulfilment_model;
      return (
        !((mode === "delivery" || mode === "both") && !fleet) &&
        !(st.held.driver_payments && !fleet)
      );
    };

    it.each([
      ["driver_payments", [], "none"],
      ["order_delivery", ["driver_payments"], "At-door payment collection"],
      [
        "recurring_routes",
        ["driver_payments", "order_delivery"],
        "At-door payment collection, Ad hoc order delivery",
      ],
    ] as const)(
      "fails at %s: only the earlier disables happened, the mode is untouched, the state is valid, the message names them",
      async (failing, before, named) => {
        const t = fakeTenant({
          addons: ["recurring_routes", "order_delivery", "driver_payments"],
          modes: { fulfilment_model: "delivery" },
          disableFails: failing,
        });
        expect(isValid(t.state())).toBe(true);
        const err = await t.controller
          .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
          .catch((e) => e);
        expect(err.getStatus()).toBe(503);
        const body = err.getResponse();
        expect(body).toMatchObject({
          code: "BUSINESS_PROFILE_BILLING_FAILED",
          featureKey: failing,
          alreadyDisabled: [...before],
        });
        expect(body.message).toContain(`Already switched off with billing stopped: ${named}.`);
        // the disables that ran are exactly the earlier ones; no mode / override write followed
        expect(t.writes).toEqual(before.map((k) => `disable ${k}`));
        expect(t.state().modes.fulfilment_model).toBe("delivery");
        expect(isValid(t.state())).toBe(true);
        expect(audits(t, AdminAuditAction.BUSINESS_PROFILE_APPLIED)).toEqual([]);
      },
    );

    it("no failure: all three disables (reverse dependency order), THEN the mode — the end state is valid", async () => {
      const t = fakeTenant({
        addons: ["recurring_routes", "order_delivery", "driver_payments"],
        modes: { fulfilment_model: "delivery" },
      });
      await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
      expect(t.writes).toEqual([
        "disable driver_payments",
        "disable order_delivery",
        "disable recurring_routes",
        "mode fulfilment_model=ship",
      ]);
      expect(isValid(t.state())).toBe(true);
    });

    it("a retry after a failure finishes the job: only the remaining disables run", async () => {
      const t = fakeTenant({
        addons: ["recurring_routes", "order_delivery", "driver_payments"],
        modes: { fulfilment_model: "delivery" },
        disableFails: "recurring_routes",
      });
      await t.controller
        .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
        .catch(() => undefined);
      t.writes.length = 0;
      t.addonService.disableAddon.mockClear();
      t.failNoMore();
      await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
      expect(t.writes).toEqual(["disable recurring_routes", "mode fulfilment_model=ship"]);
      expect(isValid(t.state())).toBe(true);
    });
  });

  it("re-applying after a paid disable is idempotent: no second billing call", async () => {
    const t = fakeTenant({ addons: ["recurring_routes"] });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    t.addonService.disableAddon.mockClear();
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
  });
});
