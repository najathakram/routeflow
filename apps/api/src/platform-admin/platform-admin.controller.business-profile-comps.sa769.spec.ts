/**
 * SA-769 (D-S2, owner answer 2026-10-10): a business profile's module grants are COMPS - the
 * existing `TenantAddon.isComp` marker (SA-693) - not feature overrides.
 *
 * Unlike platform-admin.controller.business-profiles.spec.ts (which fakes the add-on service),
 * this file runs the REAL `AddonService` (enable/disable bodies, the ledger emit, the lock calls)
 * over an in-memory add-on table, the REAL `BusinessProfileService` and the REAL controller confirm
 * route, so "isComp true, 0 Stripe calls, 0 ledger rows, 0 GRANT overrides" is read off the rows
 * and the mocks, not off a fake that says so. Mocked at the module boundary: Prisma (tenant,
 * add-on table), Stripe, the billing events, the entitlement authority, the advisory locks.
 *
 * NOTE on counts: the ruling text says "3 fleet rows + driver_payments" and "master today: 4 GRANT overrides". That is
 * an arithmetic slip: FLEET_KEYS = recurring_routes, order_delivery, so PROFILE_MODULE_KEYS has THREE modules and a
 * delivery profile writes THREE comp rows (master wrote three GRANT overrides). These specs assert three.
 *
 * The lock mock is a real keyed mutex: `withAdvisoryLocks` (the confirm's multi-key lock) holds its
 * keys until the callback ends, and a single-key `withAdvisoryLock` on a HELD key times out like the
 * real 10 s wait would. So a comp enable that tried to re-take a key its own confirm holds would
 * fail the apply here (the self-block `lockHeld` exists to prevent).
 */
const held = new Set<string>();
let waiters: Array<() => void> = [];
const wake = () => {
  const w = waiters;
  waiters = [];
  w.forEach((f) => f());
};
async function acquire(keys: string[], waitMs: number, makeErr: (k: string) => Error) {
  const deadline = Date.now() + waitMs;
  while (keys.some((k) => held.has(k))) {
    const left = deadline - Date.now();
    if (left <= 0) throw makeErr(keys.find((k) => held.has(k)) as string);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left);
      waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  keys.forEach((k) => held.add(k));
}
const release = (keys: string[]) => {
  keys.forEach((k) => held.delete(k));
  wake();
};
const mockWithAdvisoryLock = jest.fn();
const mockWithAdvisoryLocks = jest.fn();
jest.mock("../common/db-locks", () => {
  const actual = jest.requireActual("../common/db-locks");
  mockWithAdvisoryLock.mockImplementation(
    async (opts: { key: string; waitMs?: number }, fn: () => Promise<unknown>) => {
      const keys = [opts.key];
      await acquire(keys, 150, (k) => new actual.LockTimeoutError("billing", k, 150));
      try {
        return { acquired: true as const, value: await fn() };
      } finally {
        release(keys);
      }
    },
  );
  mockWithAdvisoryLocks.mockImplementation(
    async (opts: { keys: string[] }, fn: () => Promise<unknown>) => {
      const keys = [...new Set(opts.keys)].sort();
      await acquire(keys, 1_000, (k) => new actual.LockTimeoutError("billing", k, 1_000));
      try {
        return await fn();
      } finally {
        release(keys);
      }
    },
  );
  return {
    ...actual,
    withAdvisoryLock: mockWithAdvisoryLock,
    withAdvisoryLocks: mockWithAdvisoryLocks,
  };
});

import "reflect-metadata";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConflictException, Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PlatformAdminController } from "./platform-admin.controller";
import { AdminAuditAction } from "./audit-actions.constant";
import { AddonService } from "../billing/addon.service";
import { BusinessProfileService } from "../billing/business-profile.service";
import { SubscriptionMutationService } from "../billing/subscription-mutation.service";
import { billableAddonWhere } from "../billing/addon-row";
import { fakeTenantAddonStore } from "../testing/fake-tenant-addon-store";
import { mrrEmits } from "../testing/mrr-emits";

const T = "tenant-a";
const FLEET = ["recurring_routes", "order_delivery"];
const MODULES = ["recurring_routes", "order_delivery", "driver_payments"];
const admin = { sub: "admin-1", role: UserRole.SUPER_ADMIN } as any;

interface OverrideRow {
  id: string;
  tenantId: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  revokedAt: Date | null;
  expiresAt: Date | null;
}

const paidRow = (addonKey: string) => ({
  tenantId: T,
  addonKey,
  sku: null,
  active: true,
  quantity: 1,
  priceSnapshot: 49,
  stripeItemId: `si_${addonKey}`,
  isComp: false,
});

function world(
  start: {
    rows?: Array<Record<string, unknown>>;
    overrides?: Record<string, "GRANT" | "DENY">;
    modes?: Record<string, string>;
  } = {},
) {
  let seq = 0;
  const overrideRows: OverrideRow[] = Object.entries(start.overrides ?? {}).map(
    ([featureKey, effect]) => ({
      id: `seed-${++seq}`,
      tenantId: T,
      featureKey,
      effect,
      revokedAt: null,
      expiresAt: null,
    }),
  );
  const activeOverride = (key: string) =>
    overrideRows.find((r) => r.featureKey === key && !r.revokedAt);

  const store = fakeTenantAddonStore((start.rows ?? []) as any);
  const rowHolds = (key: string) => store.rows.some((r) => r.addonKey === key && r.active);
  const can = (key: string) => {
    const ov = activeOverride(key);
    return ov ? ov.effect === "GRANT" : rowHolds(key);
  };

  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: T, slug: "acme" }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      }),
    },
    tenantAddon: store,
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({ stripeSubId: "sub_1", externalPayment: false }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const stripe = {
    isConfigured: true,
    client: {
      subscriptionItems: {
        create: jest.fn().mockResolvedValue({ id: "si_new" }),
        del: jest.fn().mockResolvedValue({}),
      },
    },
  };
  const events = { emit: jest.fn().mockResolvedValue({}) };
  const writes: string[] = [];
  const featureOverrides = {
    list: jest.fn(async () => overrideRows.filter((r) => r.tenantId === T)),
    // like the real service: revoked and EXPIRED rows are not active
    allActive: jest.fn(
      async () =>
        new Map(
          overrideRows
            .filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > Date.now()))
            .map((r) => [r.featureKey, r.effect]),
        ),
    ),
    get: jest.fn(async (_t: string, key: string) => activeOverride(key)?.effect ?? null),
    getMany: jest.fn(async () => new Map()),
    create: jest.fn(async (p: { featureKey: string; effect: "GRANT" | "DENY" }) => {
      if (activeOverride(p.featureKey)) throw new ConflictException("active override exists");
      const row = { id: `ov-${++seq}`, revokedAt: null, expiresAt: null, tenantId: T, ...p };
      overrideRows.push(row as OverrideRow);
      writes.push(`override ${p.effect} ${p.featureKey}`);
      return { ...row, kind: "COMP" };
    }),
    revoke: jest.fn(async (_t: string, id: string) => {
      const row = overrideRows.find((r) => r.id === id)!;
      row.revokedAt = new Date();
      writes.push(`revoke ${row.effect} ${row.featureKey}`);
      return row;
    }),
  };
  // B524: driver_payments needs a fleet key in the SAVED state (a comp row counts), so the order
  // "fleet keys first, driver_payments last" is enforced here exactly as in production.
  const authority = {
    assertFeatureRequiresMet: jest.fn(async (_t: string, key: string) => {
      if (key === "driver_payments" && !FLEET.some(can)) {
        throw new ConflictException({ code: "FEATURE_REQUIRES_UNMET" });
      }
    }),
    invalidate: jest.fn(),
  };
  const entitlements = {
    invalidate: jest.fn(),
    resolve: jest.fn().mockResolvedValue({ flags: new Set<string>() }),
  };
  const featureResolver = { invalidate: jest.fn() };
  const catalog = { getPublishedCatalog: jest.fn().mockResolvedValue({ addonSkus: [] }) };
  const addonService = new (AddonService as any)(
    prisma,
    stripe,
    entitlements,
    catalog,
    featureResolver,
    authority,
    events,
    featureOverrides,
  ) as AddonService;

  const modes: Record<string, string> = {
    fulfilment_model: "unset",
    counter_sales: "unset",
    ...start.modes,
  };
  const stored = new Set<string>(Object.keys(start.modes ?? {}));
  const featureConfig = {
    getState: jest.fn(async (_t: string, key: string) => ({
      value: modes[key],
      effective: modes[key],
      source: stored.has(key) ? ("TENANT" as const) : ("REGISTRY_DEFAULT" as const),
      allowed: [] as string[],
      blocked: [] as string[],
    })),
    set: jest.fn(async (_t: string, key: string, mode: string) => {
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
  const featurePreview = {
    preview: jest.fn(async (_t: string, _req: unknown) => ({
      before: [],
      after: [],
      changed: ["fleet-change"],
    })),
  };
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const businessProfiles = new BusinessProfileService(
    prisma,
    featureOverrides as never,
    addonService,
    featureConfig as never,
    featurePreview as never,
  );
  const stub = () => ({}) as any;
  const controller = new PlatformAdminController(
    svc as any,
    stub(), // platformConfig
    stub(), // billingService
    addonService,
    featureOverrides as any,
    stub(), // entitlementsMode
    stub(), // configSnapshotFlag
    stub(), // featureDiffs
    authority as any,
    featurePreview as any,
    stub(), // snapshotAdmin
    businessProfiles,
    featureConfig as any,
  );
  /** The confirm as the web does it: preview first, then send that fingerprint back. */
  const apply = async (profile: string) => {
    const shown = await controller.previewBusinessProfile(T, { profile } as any);
    return controller.applyBusinessProfile(
      T,
      { profile, planFingerprint: shown.planFingerprint } as any,
      admin,
    );
  };
  const audits = (action: string) =>
    svc.recordAdminAction.mock.calls.filter((c: unknown[]) => c[2] === action).map((c) => c[3]);
  const activeRows = () => store.rows.filter((r) => r.active);
  return {
    apply,
    controller,
    businessProfiles,
    prisma,
    store,
    stripe,
    events,
    featureOverrides,
    featurePreview,
    featureConfig,
    authority,
    svc,
    audits,
    activeRows,
    writes,
    modes,
    overrideRows,
  };
}

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  held.clear();
  waiters = [];
  mockWithAdvisoryLock.mockClear();
  mockWithAdvisoryLocks.mockClear();
});

describe("SA-769 red row 1: a profile applied to a tenant holding nothing COMPS the modules", () => {
  it("3 comp rows (isComp true, price 0, no Stripe item), 0 Stripe calls, 0 ledger rows, 0 GRANT overrides", async () => {
    const w = world();

    await w.apply("delivery_distributor");

    expect(w.activeRows().map((r) => r.addonKey)).toEqual(MODULES); // fleet keys first, driver_payments last
    for (const r of w.activeRows()) {
      expect(r).toMatchObject({ isComp: true, priceSnapshot: 0, stripeItemId: null, quantity: 1 });
    }
    expect(w.stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(w.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(mrrEmits(w.events)).toHaveLength(0); // no MRR / ledger booking for a comp
    expect(w.featureOverrides.create).not.toHaveBeenCalled(); // 0 GRANT overrides
    expect(w.overrideRows).toEqual([]);
    expect(w.modes.fulfilment_model).toBe("delivery"); // the mode lands after the comps
  });

  it("the writes are the comp rows (fleet first, driver_payments last), THEN the mode", async () => {
    const w = world();
    await w.apply("delivery_distributor");
    expect(w.store.upsert.mock.calls.map((c: any[]) => c[0].create.addonKey)).toEqual(MODULES);
    expect(w.writes).toEqual(["mode fulfilment_model=delivery"]);
  });

  it("no expiry: a stale EXPIRED override does not hold the module, and the comp is written WITHOUT any end date", async () => {
    const w = world();
    w.overrideRows.push({
      id: "stale",
      tenantId: T,
      featureKey: "order_delivery",
      effect: "GRANT",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 86_400_000),
    });

    await w.apply("delivery_distributor");

    // the expired GRANT holds nothing, so order_delivery is comped like the rest
    expect(w.activeRows().map((r) => r.addonKey)).toEqual(MODULES);
    expect(w.featureOverrides.create).not.toHaveBeenCalled();
    for (const call of w.store.upsert.mock.calls) {
      for (const data of [call[0].create, call[0].update] as Array<Record<string, unknown>>) {
        expect(Object.keys(data).filter((k) => /expir|end|until|valid|trial/i.test(k))).toEqual([]);
        expect(Object.values(data).some((v) => v instanceof Date)).toBe(false);
      }
    }
    // and the table cannot hold one: its only DateTime columns are createdAt / updatedAt
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../prisma/schema/platform.prisma"),
      "utf8",
    );
    const from = schema.indexOf("model TenantAddon {");
    const model = schema.slice(from, schema.indexOf("\n}", from));
    expect([...model.matchAll(/^\s+(\w+)\s+DateTime/gm)].map((m) => m[1])).toEqual([
      "createdAt",
      "updatedAt",
    ]);
  });

  it("audits stay: one ADDON_COMPED per comp (reason names the profile), one BUSINESS_PROFILE_APPLIED listing the comp rows", async () => {
    const w = world();
    await w.apply("delivery_distributor");

    expect(w.audits(AdminAuditAction.ADDON_COMPED)).toEqual(
      MODULES.map((addonKey) =>
        expect.objectContaining({ addonKey, reason: "business profile delivery_distributor" }),
      ),
    );
    expect(w.audits(AdminAuditAction.FEATURE_OVERRIDE_SET)).toEqual([]);
    expect(w.audits(AdminAuditAction.BUSINESS_PROFILE_APPLIED)).toEqual([
      expect.objectContaining({
        profile: "delivery_distributor",
        comps: MODULES,
        plan: expect.objectContaining({ comps: MODULES.map((featureKey) => ({ featureKey })) }),
      }),
    ]);
  });

  it("the comps are made under the confirm's own locks: one multi-key lock, no single-key lock re-taken", async () => {
    const w = world();
    await w.apply("delivery_distributor");
    expect(mockWithAdvisoryLocks).toHaveBeenCalledTimes(1);
    const [opts] = mockWithAdvisoryLocks.mock.calls[0];
    expect(opts.family).toBe("billing");
    expect([...opts.keys].sort()).toEqual(MODULES.map((k) => `addon:${T}:${k}`).sort());
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled(); // lockHeld: no self-block
  });

  it("old shape: a tenant whose earlier apply wrote GRANT overrides keeps them - no revoke, no comp for that module", async () => {
    const w = world({ overrides: { recurring_routes: "GRANT" } });
    await w.apply("delivery_distributor");
    expect(w.featureOverrides.revoke).not.toHaveBeenCalled();
    expect(w.activeRows().map((r) => r.addonKey)).toEqual(["order_delivery", "driver_payments"]);
    expect(w.overrideRows.filter((o) => !o.revokedAt)).toHaveLength(1);
  });

  it("a DENY override (shipping profile earlier) is revoked, then the module is comped; no GRANT is created", async () => {
    const w = world({
      overrides: { recurring_routes: "DENY", order_delivery: "DENY", driver_payments: "DENY" },
      modes: { fulfilment_model: "ship" },
    });
    await w.apply("delivery_distributor");
    expect(w.writes).toEqual([
      "revoke DENY recurring_routes",
      "revoke DENY order_delivery",
      "revoke DENY driver_payments",
      "mode fulfilment_model=delivery",
    ]);
    expect(w.activeRows().map((r) => [r.addonKey, r.isComp])).toEqual(
      MODULES.map((k) => [k, true]),
    );
    expect(w.featureOverrides.create).not.toHaveBeenCalled();
  });
});

describe("SA-769 red row 2: a module the tenant already pays for stays billable", () => {
  it("that row (snapshot and Stripe item) is untouched; the other modules are comped", async () => {
    const w = world({ rows: [paidRow("order_delivery")] });
    const before = { ...w.store.rows[0] };

    await w.apply("delivery_distributor");

    const paid = w.store.rows.find((r) => r.addonKey === "order_delivery")!;
    expect(paid).toEqual(before); // not re-priced, not converted into a comp
    expect(paid).toMatchObject({
      isComp: false,
      priceSnapshot: 49,
      stripeItemId: "si_order_delivery",
    });
    expect(
      w.store.rows
        .filter((r) => r.addonKey !== "order_delivery")
        .map((r) => [r.addonKey, r.isComp]),
    ).toEqual([
      ["recurring_routes", true],
      ["driver_payments", true],
    ]);
    expect(w.stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(w.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(mrrEmits(w.events)).toHaveLength(0);
    expect(w.audits(AdminAuditAction.ADDON_COMPED).map((a: any) => a.addonKey)).toEqual([
      "recurring_routes",
      "driver_payments",
    ]);
  });

  it("an existing comp row is left as it is (not re-written)", async () => {
    const w = world({
      rows: [
        { ...paidRow("recurring_routes"), isComp: true, priceSnapshot: 0, stripeItemId: null },
      ],
    });
    await w.apply("delivery_distributor");
    expect(w.store.upsert.mock.calls.map((c: any[]) => c[0].create.addonKey)).toEqual([
      "order_delivery",
      "driver_payments",
    ]);
  });
});

describe("SA-769 red row 3: checkout for a comped tenant is not blocked and shows no comp as a billable line", () => {
  it("every row the apply wrote is excluded by billableAddonWhere, and the checkout builder returns no line", async () => {
    const w = world();
    await w.apply("delivery_distributor");
    expect(w.activeRows()).toHaveLength(3); // the comps exist, so an empty billable read is not vacuous

    const billable = await w.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId: T, active: true }),
    });
    expect(billable).toEqual([]);

    // the real checkout builder, reading the same table: no line, nothing to refuse
    const checkout = Object.create(SubscriptionMutationService.prototype) as any;
    checkout.prisma = w.prisma;
    await expect(checkout.checkoutAddonLines(T, "year")).resolves.toEqual({
      lineItems: [],
      skus: [],
      invalid: [],
    });
  });

  it("a tenant paying for one module and comped for the rest: only the paid row is billable", async () => {
    const w = world({ rows: [paidRow("order_delivery")] });
    await w.apply("delivery_distributor");
    expect(w.activeRows().map((r) => [r.addonKey, r.isComp])).toEqual([
      ["order_delivery", false],
      ["recurring_routes", true],
      ["driver_payments", true],
    ]);
    const billable = await w.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId: T, active: true }),
    });
    expect(billable.map((r: any) => r.addonKey)).toEqual(["order_delivery"]);
  });
});

describe("SA-769 red row 4: applying a fleet:false profile afterwards switches the comps off, no Stripe call", () => {
  it("each comp row is disabled in BILLING_DISABLE_ORDER (driver_payments first), 0 Stripe calls, 0 ledger rows, no DENY override", async () => {
    const w = world();
    await w.apply("delivery_distributor");
    w.svc.recordAdminAction.mockClear();

    await w.apply("shipping_wholesaler");

    expect(w.store.rows.every((r) => r.active === false)).toBe(true);
    expect(w.audits(AdminAuditAction.ADDON_DISABLED).map((a: any) => a.addonKey)).toEqual([
      "driver_payments",
      "order_delivery",
      "recurring_routes",
    ]);
    expect(w.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(w.stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(mrrEmits(w.events)).toHaveLength(0);
    expect(w.featureOverrides.create).not.toHaveBeenCalled();
    expect(w.modes.fulfilment_model).toBe("ship");
  });

  it("a paid module and a comp side by side: the Stripe item is removed for the paid one only", async () => {
    const w = world({
      rows: [
        paidRow("order_delivery"),
        { ...paidRow("recurring_routes"), isComp: true, priceSnapshot: 0, stripeItemId: null },
      ],
      modes: { fulfilment_model: "delivery" },
    });

    await w.apply("shipping_wholesaler");

    expect(w.stripe.client.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(w.stripe.client.subscriptionItems.del).toHaveBeenCalledWith("si_order_delivery");
    expect(w.store.rows.every((r) => r.active === false)).toBe(true);
  });

  it("a fleet:false profile over a GRANT override (no add-on row) revokes it and DENYs through the override path (single caller kept)", async () => {
    const w = world({
      overrides: { order_delivery: "GRANT" },
      modes: { fulfilment_model: "delivery" },
    });
    await w.apply("shipping_wholesaler");
    expect(w.writes).toEqual([
      "mode fulfilment_model=ship",
      "revoke GRANT order_delivery",
      "override DENY order_delivery",
    ]);
    expect(w.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it("a fleet:false profile on a tenant holding NO add-on row and NO override writes no DENY: nothing is held, the planner skips (ruling 6 says DENY; the planner has always skipped an unheld module)", async () => {
    const w = world({ modes: { fulfilment_model: "delivery" } });
    const preview = await w.controller.previewBusinessProfile(T, {
      profile: "shipping_wholesaler",
    } as any);
    expect(preview.plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(preview.plan.comps).toEqual([]);
    expect(preview.plan.billing).toEqual([]);
    await w.apply("shipping_wholesaler");
    expect(w.featureOverrides.create).not.toHaveBeenCalled();
    expect(w.writes).toEqual(["mode fulfilment_model=ship"]);
  });

  it("a fleet:false profile over an UNPRICED non-comp row (isComp false) DENYs it with an override and does not disable it", async () => {
    const w = world({
      rows: [{ ...paidRow("recurring_routes"), priceSnapshot: 0, stripeItemId: null }],
    });
    await w.apply("shipping_wholesaler");
    expect(w.writes).toContain("override DENY recurring_routes");
    expect(w.store.rows[0]).toMatchObject({ active: true });
    expect(w.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
  });
});

describe("SA-769 red row 6: re-applying is idempotent", () => {
  it("the second apply changes nothing: no new row, no second comp, no write, no Stripe call", async () => {
    const w = world();
    await w.apply("delivery_distributor");
    const rowsAfterFirst = JSON.parse(JSON.stringify(w.store.rows));
    w.store.upsert.mockClear();
    w.writes.length = 0;

    const again = await w.controller.previewBusinessProfile(T, {
      profile: "delivery_distributor",
    } as any);
    expect(again.plan.comps).toEqual([]);
    expect(again.summary).toEqual([]);
    await w.apply("delivery_distributor");

    expect(w.store.upsert).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
    expect(JSON.parse(JSON.stringify(w.store.rows))).toEqual(rowsAfterFirst);
    expect(w.store.rows).toHaveLength(3);
    expect(w.stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(w.audits(AdminAuditAction.ADDON_COMPED)).toHaveLength(3); // the first apply's three only
  });
});

describe("SA-769 red row 7: concurrent applies serialize under the add-on locks", () => {
  it("two confirms of the same preview: one comps, the other re-plans under the lock and is refused 409 PROFILE_PLAN_CHANGED - never a second comp", async () => {
    const w = world();
    const shown = await w.controller.previewBusinessProfile(T, {
      profile: "delivery_distributor",
    } as any);
    const confirm = () =>
      w.controller.applyBusinessProfile(
        T,
        { profile: "delivery_distributor", planFingerprint: shown.planFingerprint } as any,
        admin,
      );

    const results = await Promise.allSettled([confirm(), confirm()]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.getResponse()).toMatchObject({ code: "PROFILE_PLAN_CHANGED" });
    expect(w.store.rows).toHaveLength(3);
    expect(w.store.upsert).toHaveBeenCalledTimes(3);
    expect(w.audits(AdminAuditAction.ADDON_COMPED)).toHaveLength(3);
    // both confirms asked for the SAME sorted key set: they cannot interleave
    const keySets = mockWithAdvisoryLocks.mock.calls.map((c) => [...c[0].keys].sort());
    expect(keySets).toHaveLength(2);
    expect(keySets[0]).toEqual(keySets[1]);
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
  });
});
