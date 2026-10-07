jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
  // the confirm's multi-key lock: a pass-through here (no DB); its own spec is db-locks.multi.spec.ts
  withAdvisoryLocks: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));
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
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { deriveFulfilmentCapability } from "../billing/fulfilment-capability";

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
  /** A config key whose (existing) set() rejects — a DB blip after billing was stopped. */
  setFails?: string;
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
  const failing = {
    key: start.disableFails as string | undefined,
    setKey: start.setFails as string | undefined,
  };
  const paid = new Set(start.addons ?? []);
  const modes: Record<string, string> = {
    fulfilment_model: "unset",
    counter_sales: "unset",
    ...start.modes,
  };
  const stored = new Set<string>(Object.keys(start.modes ?? {}));
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
      // a stored row is TENANT; a key never written reads its registry default (like the real store)
      source: stored.has(key) ? ("TENANT" as const) : ("REGISTRY_DEFAULT" as const),
      allowed: [] as string[],
      blocked: [] as string[],
    })),
    set: jest.fn(async (_t: string, key: string, mode: string) => {
      if (key === failing.setKey) throw new Error("connection terminated unexpectedly");
      if (key === "fulfilment_model" && (mode === "delivery" || mode === "both")) {
        if (!FLEET.some(can)) {
          throw new ConflictException({ code: "FULFILMENT_MODE_NEEDS_FLEET", key, mode });
        }
      }
      modes[key] = mode;
      stored.add(key);
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
    // the explain trace (B1132): every registry key resolves ON from the plan default, exactly the
    // "the new resolver says ON, the old path says OFF" shape the demo console showed
    resolveAll: jest.fn(async () => ({
      planKey: "SCALE",
      catalogVersionId: "cat-1",
      computedAt: "2026-10-05T00:00:00.000Z",
      byKey: new Map(
        FEATURE_REGISTRY.map((f) => [
          f.key,
          { key: f.key, effective: true, source: "PRESET", term: "default", charged: false },
        ]),
      ),
    })),
    computeOldPathAll: jest.fn(async () => new Map(FEATURE_REGISTRY.map((f) => [f.key, false]))),
  };
  const entitlementsMode = { getMode: jest.fn(async () => "shadow") };
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
    entitlementsMode as any,
    stub() as any, // configSnapshotFlag
    stub() as any, // featureDiffs
    authority as any,
    featurePreview as any,
    stub() as any, // snapshotAdmin
    businessProfiles,
    featureConfig as any,
  ) as Omit<PlatformAdminController, "applyBusinessProfile"> & {
    // the confirm as these tests call it: `planFingerprint` may be left out, the preview-first
    // wrapper below fills it in exactly as the web does (rawConfirm sends the body unchanged)
    applyBusinessProfile(
      id: string,
      dto: { profile: string; reason?: string; planFingerprint?: string },
      admin: unknown,
    ): ReturnType<PlatformAdminController["applyBusinessProfile"]>;
  };
  // Confirm as the web does it: preview first, send that planFingerprint back (#3199 review).
  // A test that passes its own fingerprint keeps it; a preview that refuses leaves a dummy one,
  // so the confirm's own refusal (unknown profile, ...) is what the test sees.
  const confirm = controller.applyBusinessProfile.bind(controller); // the real route, no auto-fill
  controller.applyBusinessProfile = (async (id: string, dto: any, user: any) => {
    const planFingerprint =
      dto.planFingerprint ??
      (await controller
        .previewBusinessProfile(id, { profile: dto.profile })
        .then((p) => p.planFingerprint)
        .catch(() => "0".repeat(64)));
    return confirm(id, { ...dto, planFingerprint }, user);
  }) as typeof controller.applyBusinessProfile;
  const state = () => ({
    modes: { ...modes },
    held: Object.fromEntries(
      ["recurring_routes", "order_delivery", "driver_payments"].map((k) => [k, can(k)]),
    ),
    activeOverrides: rows.filter((r) => !r.revokedAt).length,
  });
  return {
    /** The confirm route WITHOUT the preview-first wrapper. */
    rawConfirm: confirm,
    /** A paid add-on switched on behind the admin's back (between preview and confirm). */
    enablePaid: (key: string) => {
      addons.add(key);
      paid.add(key);
    },
    failNoMore: () => {
      failing.key = undefined;
      failing.setKey = undefined;
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

  it("preview returns a stable planFingerprint (the same plan hashes the same)", async () => {
    const { controller } = fakeTenant({});
    const a = await controller.previewBusinessProfile(T, { profile: "delivery_distributor" });
    const b = await controller.previewBusinessProfile(T, { profile: "delivery_distributor" });
    expect(a.planFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.planFingerprint).toBe(a.planFingerprint);
    const other = await controller.previewBusinessProfile(T, { profile: "shipping_wholesaler" });
    expect(other.planFingerprint).not.toBe(a.planFingerprint);
  });
});

describe("confirm applies only the plan that was previewed (#3199 review)", () => {
  it("a plan that changed since the preview is a 409 PROFILE_PLAN_CHANGED and NOTHING is written", async () => {
    const t = fakeTenant({});
    const shown = await t.controller.previewBusinessProfile(T, { profile: "delivery_distributor" });
    // between preview and confirm, the tenant's state moves (here: the confirm targets a plan
    // other than the one shown, exactly what an add-on turned on in between produces)
    const stale = { ...shown, planFingerprint: "f".repeat(64) };
    await expect(
      t.controller.applyBusinessProfile(
        T,
        { profile: "delivery_distributor", planFingerprint: stale.planFingerprint } as any,
        admin,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "PROFILE_PLAN_CHANGED" }),
    });
    expect(t.writes).toEqual([]);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
  });

  it("a confirm with NO fingerprint is a 400 and writes nothing (the route itself, no auto-fill)", async () => {
    const t = fakeTenant({});
    await expect(
      t.rawConfirm(T, { profile: "delivery_distributor" } as any, admin),
    ).rejects.toMatchObject({ status: 400 });
    expect(t.writes).toEqual([]);
  });

  it("a PAID add-on switched on between preview and confirm changes the plan: 409, nothing written or stopped", async () => {
    const t = fakeTenant({});
    const shown = await t.controller.previewBusinessProfile(T, { profile: "shipping_wholesaler" });
    expect(shown.plan.billing).toEqual([]); // nothing to stop when the admin looked
    t.enablePaid("driver_payments"); // now the tenant PAYS for a module the profile switches off
    await expect(
      t.rawConfirm(
        T,
        { profile: "shipping_wholesaler", planFingerprint: shown.planFingerprint } as any,
        admin,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "PROFILE_PLAN_CHANGED" }),
    });
    expect(t.writes).toEqual([]);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
  });

  it("billing and its manual flag are part of the fingerprint", async () => {
    const paidStripe = fakeTenant({ addons: ["driver_payments"] });
    const a = await paidStripe.controller.previewBusinessProfile(T, {
      profile: "shipping_wholesaler",
    });
    const comped = fakeTenant({ comped: ["driver_payments"] });
    const b = await comped.controller.previewBusinessProfile(T, { profile: "shipping_wholesaler" });
    expect(a.plan.billing.length).toBe(1);
    expect(b.plan.billing.length).toBe(0);
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it("plan-then-apply holds the add-on enable path's keys (billing family, addon:<tenant>:<sku>) in ONE multi-key lock", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withAdvisoryLocks } = require("../common/db-locks");
    (withAdvisoryLocks as jest.Mock).mockClear();
    const t = fakeTenant({});
    await t.controller.applyBusinessProfile(T, { profile: "delivery_distributor" } as any, admin);
    expect(withAdvisoryLocks).toHaveBeenCalledTimes(1); // one connection for all three keys
    const [opts] = (withAdvisoryLocks as jest.Mock).mock.calls[0];
    expect(opts.family).toBe("billing");
    expect(opts.keys).toHaveLength(3);
    for (const k of opts.keys) expect(k.startsWith(`addon:${T}:`)).toBe(true);
  });

  it.each([
    [
      "a lock timeout",
      () => new (jest.requireActual("../common/db-locks").LockTimeoutError)("billing", "k", 10_000),
    ],
    [
      "no lock connection",
      () => new (jest.requireActual("../common/db-locks").LockUnavailableError)(null),
    ],
  ])(
    "%s on the confirm lock is a 503 LOCK_UNAVAILABLE and nothing is written",
    async (_name, err) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { withAdvisoryLocks } = require("../common/db-locks");
      (withAdvisoryLocks as jest.Mock).mockRejectedValueOnce(err());
      const t = fakeTenant({});
      await expect(
        t.controller.applyBusinessProfile(T, { profile: "delivery_distributor" } as any, admin),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: "LOCK_UNAVAILABLE" }),
      });
      expect(t.writes).toEqual([]);
    },
  );

  it("the previewed fingerprint confirms", async () => {
    const t = fakeTenant({});
    const shown = await t.controller.previewBusinessProfile(T, { profile: "delivery_distributor" });
    await t.controller.applyBusinessProfile(
      T,
      { profile: "delivery_distributor", planFingerprint: shown.planFingerprint } as any,
      admin,
    );
    expect(t.writes.length).toBeGreaterThan(0);
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

  it.each([
    ["in_store_retailer", "pickup"],
    ["in_store_shipping_retailer", "pickup_ship"],
  ])(
    "SA-671 M1 lifted: %s (%s, now available) applies through the audited writes",
    async (profile, mode) => {
      const t = fakeTenant({ addons: ["recurring_routes"] });
      await t.controller.applyBusinessProfile(T, { profile: profile as never }, admin);
      expect(t.writes).toEqual(
        expect.arrayContaining([
          `mode fulfilment_model=${mode}`,
          "mode counter_sales=on",
          "disable recurring_routes",
        ]),
      );
      expect(t.svc.recordAdminAction).toHaveBeenCalled();
      expect(t.state().modes).toMatchObject({ fulfilment_model: mode, counter_sales: "on" });
    },
  );

  // The refusal is DERIVED from registry availability (unavailableModes), so it stays covered by marking the
  // live registry row unavailable for one test (restored in finally).
  const withUnavailable = async (mode: string, run: () => Promise<void>) => {
    const row = FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes[mode] as {
      available: boolean;
    };
    row.available = false;
    try {
      await run();
    } finally {
      row.available = true;
    }
  };

  it.each([
    ["in_store_retailer", "pickup"],
    ["in_store_shipping_retailer", "pickup_ship"],
  ])(
    "SA-671 M1 (registry fixture: %s's mode %s marked unavailable) is refused with BUSINESS_PROFILE_UNAVAILABLE before ANY write",
    async (profile, mode) => {
      await withUnavailable(mode, async () => {
        const t = fakeTenant({ addons: ["recurring_routes"] });
        const err = await t.controller
          .applyBusinessProfile(T, { profile: profile as never }, admin)
          .catch((e) => e);
        expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNAVAILABLE" });
        expect(t.writes).toEqual([]);
        expect(t.svc.recordAdminAction).not.toHaveBeenCalled();
      });
    },
  );

  it("SA-671 M1 bypass (registry fixture): a tenant ALREADY stored in-store is still refused while its mode is unavailable — no counter_sales, no DENYs", async () => {
    await withUnavailable("pickup", async () => {
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
        expect(body).not.toHaveProperty("cause"); // no server text in the body (SA)
        expect(body.failedStep).toEqual({ step: "billing", key: failing });
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

describe("SA MUST: a failure AFTER a successful billing disable returns the SAME coded 503", () => {
  it("disable ok, then set() rejects → 503 BUSINESS_PROFILE_BILLING_FAILED naming what was stopped and the failing step; a second confirm completes with NO further billing call", async () => {
    const t = fakeTenant({
      addons: ["recurring_routes"],
      modes: { fulfilment_model: "delivery" },
      setFails: "fulfilment_model",
    });
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
      .catch((e) => e);
    expect(err.getStatus()).toBe(503);
    const body = err.getResponse();
    expect(body).toMatchObject({
      code: "BUSINESS_PROFILE_BILLING_FAILED",
      alreadyDisabled: ["recurring_routes"],
      failedStep: { step: "mode", key: "fulfilment_model" },
    });
    expect(body).not.toHaveProperty("cause");
    expect(JSON.stringify(body)).not.toContain("connection terminated"); // no server text
    expect(body.message).toContain("Already switched off with billing stopped: Recurring routes.");
    expect(t.writes).toEqual(["disable recurring_routes"]);

    // the admin retries
    t.failNoMore();
    t.writes.length = 0;
    t.addonService.disableAddon.mockClear();
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
    expect(t.writes).toEqual(["mode fulfilment_model=ship"]);
    expect(t.state().modes.fulfilment_model).toBe("ship");
  });

  it("a failing override write after a disable is reported the same way, naming the override step", async () => {
    const t = fakeTenant({
      addons: ["recurring_routes"],
      overrides: { order_delivery: "GRANT" },
      modes: { fulfilment_model: "delivery" },
    });
    t.featureOverrides.create.mockRejectedValueOnce(new Error("deadlock detected"));
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({
      code: "BUSINESS_PROFILE_BILLING_FAILED",
      alreadyDisabled: ["recurring_routes"],
      failedStep: { step: "deny", key: "order_delivery" },
    });
    expect(err.getResponse()).not.toHaveProperty("cause");
  });

  it("with NO billing disable done, a later failure keeps its own error (nothing was stopped to report)", async () => {
    const t = fakeTenant({ comped: ["recurring_routes"], setFails: "fulfilment_model" });
    const err = await t.controller
      .applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin)
      .catch((e) => e);
    expect(err.message).toBe("connection terminated unexpectedly");
    expect(t.addonService.disableAddon).not.toHaveBeenCalled();
  });
});

describe("effective-features carries the applied fulfilment mode (B1132)", () => {
  const consoleRow = async (t: ReturnType<typeof fakeTenant>, key: string) => {
    const res = (await t.controller.getTenantFeaturesEffective(T)) as {
      effective: Array<{ key: string; mode?: Record<string, unknown> }>;
    };
    return res.effective.find((f) => f.key === key);
  };

  it("after a profile is applied, the console row's mode IS the one the Current setup card reads", async () => {
    const t = fakeTenant({ addons: [] });
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);

    // the card: GET feature-config/fulfilment_model -> featureConfig.getState(...).value
    const card = await t.featureConfig.getState(T, "fulfilment_model");
    expect(card.value).toBe("ship");

    // the console row: effective-features, same resolver, with its true source
    const row = await consoleRow(t, "fulfilment_model");
    expect(row?.mode).toMatchObject({ value: "ship", effective: "ship", source: "TENANT" });
    expect(row?.mode?.value).toBe(card.value);
    // ...and the capability the apps act on agrees: SHIP only
    expect(
      deriveFulfilmentCapability({
        mode: String(row?.mode?.effective),
        counterSales: "off",
        fleet: false,
      }).methods,
    ).toEqual(["SHIP"]);
  });

  it("a never-configured tenant reads its registry default, not a tenant value", async () => {
    const t = fakeTenant({});
    const row = await consoleRow(t, "fulfilment_model");
    expect(row?.mode).toMatchObject({
      value: "unset",
      effective: "unset",
      source: "REGISTRY_DEFAULT",
    });
  });

  it("the single-key route carries the same mode", async () => {
    const t = fakeTenant({});
    await t.controller.applyBusinessProfile(T, { profile: "shipping_wholesaler" }, admin);
    const one = (await t.controller.getTenantFeatureEffective(T, "fulfilment_model")) as {
      mode?: { value: string };
    };
    expect(one.mode?.value).toBe("ship");
  });

  it("a key with no config block carries no mode", async () => {
    const t = fakeTenant({});
    const plain = FEATURE_REGISTRY.find((f) => !f.config)!;
    expect((await consoleRow(t, plain.key))?.mode).toBeUndefined();
  });

  it("a failed mode read leaves the row without a mode instead of failing the whole trace", async () => {
    const t = fakeTenant({});
    t.featureConfig.getState.mockRejectedValueOnce(new Error("db blip"));
    const res = (await t.controller.getTenantFeaturesEffective(T)) as { effective: unknown[] };
    expect(res.effective.length).toBe(FEATURE_REGISTRY.length);
  });
});
