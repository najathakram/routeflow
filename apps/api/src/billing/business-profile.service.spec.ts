/**
 * BusinessProfileService — list, plan and preview. Red-first: written before the service existed.
 *
 * Reads the tenant's current state through the EXISTING services only (FeatureOverrideService for
 * the active overrides, FeatureConfigService for can() and the stored modes) and previews through
 * the EXISTING FeaturePreviewService. It writes nothing: the confirm path is the platform-admin
 * controller's own audited override + feature-config writes.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BusinessProfileService } from "./business-profile.service";
import { FEATURE_REGISTRY } from "./feature-registry";

const T = "tenant-a";
const DAY = 86_400_000;

function overrideRow(p: {
  id: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  tenantId?: string;
}) {
  return { tenantId: T, revokedAt: null, expiresAt: null, ...p };
}

function build(
  opts: {
    tenant?: { id: string } | null;
    overrides?: ReturnType<typeof overrideRow>[];
    /** Active TenantAddon rows; `paid` = a Stripe item or a positive price, else a comped row. */
    addons?: (string | { key: string; paid: boolean; manual?: boolean; comp?: boolean })[];
    modes?: Record<string, string>;
    /** Open SHIP orders already handed to the carrier (shippedAt set). */
    inTransit?: number;
  } = {},
) {
  const addonRows = (opts.addons ?? []).map((a) =>
    typeof a === "string" ? { key: a, paid: true, manual: false } : { manual: false, ...a },
  );
  const prisma = {
    order: { count: jest.fn().mockResolvedValue(opts.inTransit ?? 0) },
    tenant: {
      findUnique: jest.fn().mockResolvedValue(opts.tenant === undefined ? { id: T } : opts.tenant),
    },
    tenantAddon: {
      // addonRowWhere(tenantId, sku): { tenantId, OR: [{ addonKey: sku }, { sku }, …] }
      findFirst: jest.fn(async ({ where }: any) => {
        const key = where.OR[0].addonKey;
        const row = addonRows.find((r) => r.key === key && where.tenantId === T);
        return row
          ? {
              addonKey: row.key,
              active: true,
              // manual pay = a price, no Stripe item (a manual/external-payment activation)
              stripeItemId: row.paid && !row.manual ? "si_x" : null,
              priceSnapshot: row.paid ? "49.00" : null,
              isComp: row.comp === true,
            }
          : null;
      }),
    },
  };
  // Deliberately NO `create`/`revoke`: a write from this service would throw.
  const rows = opts.overrides ?? [];
  const now = Date.now();
  const featureOverrides = {
    list: jest.fn().mockResolvedValue(rows),
    allActive: jest.fn(
      async () =>
        new Map(
          rows
            .filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now))
            .map((r) => [r.featureKey, r.effect]),
        ),
    ),
  };
  const addons = { getActiveAddons: jest.fn().mockResolvedValue(addonRows.map((r) => r.key)) };
  const modes = opts.modes ?? { fulfilment_model: "unset", counter_sales: "unset" };
  const featureConfig = {
    getState: jest.fn(async (_t: string, key: string) => ({
      value: modes[key] ?? "unset",
      effective: modes[key] ?? "unset",
    })),
    set: jest.fn(),
    clear: jest.fn(),
  };
  const previewResponse = { before: [], after: [], changed: ["driver_payments"] };
  const featurePreview = { preview: jest.fn().mockResolvedValue(previewResponse) };
  const svc = new BusinessProfileService(
    prisma as never,
    featureOverrides as never,
    addons as never,
    featureConfig as never,
    featurePreview as never,
  );
  return { svc, prisma, featureOverrides, addons, featureConfig, featurePreview, previewResponse };
}

describe("BusinessProfileService.list", () => {
  it("returns the five profiles as shared summaries, in registry order", () => {
    const { svc } = build();
    const res = svc.list();
    expect(res.profiles.map((p) => p.key)).toEqual([
      "delivery_distributor",
      "shipping_wholesaler",
      "in_store_retailer",
      "in_store_shipping_retailer",
      "delivery_pos",
    ]);
    // availability comes from the feature registry (SA-671 M1 lifted): the pickup modes are available
    expect(res.profiles.map((p) => p.available)).toEqual([true, true, true, true, true]);
  });
});

describe("BusinessProfileService.preview", () => {
  it("400 BUSINESS_PROFILE_UNKNOWN for a key that is not a profile — before any read", async () => {
    const { svc, prisma, featureOverrides } = build();
    const err = await svc.preview(T, "pickup_counter").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNKNOWN" });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(featureOverrides.list).not.toHaveBeenCalled();
  });

  it("404 for a tenant that does not exist", async () => {
    const { svc } = build({ tenant: null });
    await expect(svc.preview("nope", "shipping_wholesaler")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("previews through the EXISTING feature preview; a PAID add-on is planned as a billing disable and says so in plain English (OWNER RULING)", async () => {
    const { svc, featurePreview, previewResponse } = build({
      addons: ["recurring_routes", { key: "driver_payments", paid: false }],
    });
    const res = await svc.preview(T, "shipping_wholesaler");
    const reason = "Business profile: Shipping wholesaler";
    // the preview models the end state: both modules off (the paid one via its disable)
    expect(featurePreview.preview).toHaveBeenCalledWith(T, {
      overrides: [
        { featureKey: "recurring_routes", effect: "DENY", reason },
        { featureKey: "driver_payments", effect: "DENY", reason },
      ],
      modes: { fulfilment_model: "ship" },
    });
    expect(res).toEqual({
      ...previewResponse,
      planFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      changes: [
        "Where orders go: Not configured (today's behavior) → Ship by carrier",
        "Turn off At-door payment collection",
      ],
      profile: "shipping_wholesaler",
      plan: {
        overrides: [
          { featureKey: "recurring_routes", effect: "DENY", action: "skip" },
          { featureKey: "order_delivery", effect: "DENY", action: "skip" },
          { featureKey: "driver_payments", effect: "DENY", action: "create" },
        ],
        comps: [],
        modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
        billing: [{ featureKey: "recurring_routes", action: "disable", manual: false }],
      },
      summary: [
        "Recurring routes will be switched off and its billing stopped",
        "Where orders go: Not configured (today's behavior) → Ship by carrier",
        "Turn off At-door payment collection",
      ],
    });
  });

  it("a comp (override-only) module that is switched off carries no billing line", async () => {
    const { svc } = build({
      overrides: [overrideRow({ id: "g", featureKey: "recurring_routes", effect: "GRANT" })],
    });
    const res = await svc.preview(T, "shipping_wholesaler");
    expect(res.summary).toEqual([
      "Where orders go: Not configured (today's behavior) → Ship by carrier",
      'Turn off Recurring routes (replaces the current "on" override)',
    ]);
  });

  it("writes NOTHING (no override, no config row)", async () => {
    const { svc, featureConfig } = build();
    await svc.preview(T, "delivery_distributor");
    expect(featureConfig.set).not.toHaveBeenCalled();
    expect(featureConfig.clear).not.toHaveBeenCalled();
  });

  it("is tenant-scoped: every read names the target tenant and nothing else", async () => {
    const { svc, prisma, featureOverrides, addons, featureConfig, featurePreview } = build({
      addons: ["recurring_routes"],
    });
    await svc.preview(T, "shipping_wholesaler");
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: T },
      select: { id: true },
    });
    expect(featureOverrides.list).toHaveBeenCalledWith(T);
    for (const [arg] of prisma.tenantAddon.findFirst.mock.calls) expect(arg.where.tenantId).toBe(T);
    for (const call of [
      ...featureOverrides.allActive.mock.calls,
      ...addons.getActiveAddons.mock.calls,
      ...featureConfig.getState.mock.calls,
      ...featurePreview.preview.mock.calls,
    ]) {
      expect(call[0]).toBe(T);
    }
  });
});

describe("BusinessProfileService.plan — the confirm-time plan", () => {
  it("reads only ACTIVE overrides (revoked and expired rows are ignored) and returns the row to revoke for each replace", async () => {
    const now = Date.now();
    const { svc } = build({
      overrides: [
        overrideRow({
          id: "old",
          featureKey: "order_delivery",
          effect: "DENY",
          revokedAt: new Date(now - DAY),
        }),
        overrideRow({
          id: "expired",
          featureKey: "recurring_routes",
          effect: "DENY",
          expiresAt: new Date(now - DAY),
        }),
        overrideRow({
          id: "live",
          featureKey: "order_delivery",
          effect: "DENY",
          expiresAt: new Date(now + DAY),
        }),
      ],
    });
    const res = await svc.plan(T, "delivery_distributor");
    // SA-769: the live DENY is revoked on its own; every module the tenant lacks is a COMP row
    expect(res.plan.overrides).toEqual([
      { featureKey: "recurring_routes", effect: "GRANT", action: "skip" },
      { featureKey: "order_delivery", effect: "GRANT", action: "revoke" },
      { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
    ]);
    expect(res.plan.comps.map((c) => c.featureKey)).toEqual([
      "recurring_routes",
      "order_delivery",
      "driver_payments",
    ]);
    expect(res.revokeOverrideIds).toEqual({ order_delivery: "live" });
    expect(res.profile.key).toBe("delivery_distributor");
  });

  it("a tenant that already matches plans nothing: before == after", async () => {
    const { svc } = build({
      overrides: [overrideRow({ id: "d", featureKey: "driver_payments", effect: "DENY" })],
      modes: { fulfilment_model: "ship", counter_sales: "unset" },
    });
    const res = await svc.plan(T, "shipping_wholesaler");
    expect(res.plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(res.plan.modes).toEqual([]);
    expect(res.summary).toEqual([]);
  });
});

describe("SA-671 M2 — driver payments is held exactly as its guard decides", () => {
  const plannedDriverPayments = async (opts: Parameters<typeof build>[0]) => {
    const res = await build(opts).svc.plan(T, "delivery_distributor");
    return {
      override: res.plan.overrides.find((o) => o.featureKey === "driver_payments"),
      comped: res.plan.comps.some((c) => c.featureKey === "driver_payments"),
    };
  };

  it("SA-769: no add-on row and no override = NOT held (the guard 403s), so the profile COMPS it (no override)", async () => {
    expect(await plannedDriverPayments({})).toEqual({
      override: { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
      comped: true,
    });
  });

  it("an active add-on row = held: nothing to do, not comped", async () => {
    expect(await plannedDriverPayments({ addons: ["driver_payments"] })).toEqual({
      override: { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
      comped: false,
    });
  });

  it("SA-769: a DENY override beats the add-on row (override is absolute): it is revoked, and the row it hid holds the module (no comp)", async () => {
    expect(
      await plannedDriverPayments({
        addons: ["driver_payments"],
        overrides: [overrideRow({ id: "x", featureKey: "driver_payments", effect: "DENY" })],
      }),
    ).toEqual({
      override: { featureKey: "driver_payments", effect: "GRANT", action: "revoke" },
      comped: false,
    });
  });
});

describe("SA-769 — a profile grants add-on modules as COMPS and never re-prices what exists", () => {
  it("a tenant holding nothing: three comps, no GRANT override planned, the preview models the end state as ON", async () => {
    const { svc, featurePreview } = build();
    const res = await svc.preview(T, "delivery_distributor");
    expect(res.plan.comps.map((c) => c.featureKey)).toEqual([
      "recurring_routes",
      "order_delivery",
      "driver_payments",
    ]);
    expect(res.plan.overrides.every((o) => o.action === "skip")).toBe(true);
    const reason = "Business profile: Delivery distributor";
    expect(featurePreview.preview).toHaveBeenCalledWith(T, {
      overrides: [
        { featureKey: "recurring_routes", effect: "GRANT", reason },
        { featureKey: "order_delivery", effect: "GRANT", reason },
        { featureKey: "driver_payments", effect: "GRANT", reason },
      ],
      modes: { fulfilment_model: "delivery" },
    });
    expect(res.summary.slice(0, 3)).toEqual([
      "Turn on Recurring routes: included free with this profile, no charge added",
      "Turn on Ad hoc order delivery: included free with this profile, no charge added",
      "Turn on At-door payment collection: included free with this profile, no charge added",
    ]);
    // the comp lines are NOT in changes (the modal renders them from plan.comps)
    expect(res.changes).toEqual([
      "Where orders go: Not configured (today's behavior) → Own delivery",
    ]);
  });

  it("a tenant already paying for one fleet add-on: that module is not comped and nothing about it changes", async () => {
    const { svc } = build({ addons: [{ key: "order_delivery", paid: true }] });
    const res = await svc.plan(T, "delivery_distributor");
    expect(res.plan.comps.map((c) => c.featureKey)).toEqual([
      "recurring_routes",
      "driver_payments",
    ]);
    expect(res.plan.billing).toEqual([]);
    expect(res.summary.join("|")).not.toContain("Ad hoc order delivery");
  });

  it("a tenant already holding comp rows plans no second comp (idempotent re-apply)", async () => {
    const all = ["recurring_routes", "order_delivery", "driver_payments"].map((key) => ({
      key,
      paid: false,
      comp: true,
    }));
    const { svc } = build({
      addons: all,
      modes: { fulfilment_model: "delivery", counter_sales: "unset" },
    });
    const res = await svc.plan(T, "delivery_distributor");
    expect(res.plan.comps).toEqual([]);
    expect(res.plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(res.summary).toEqual([]);
  });

  it("old shape: a GRANT override written by an earlier apply is left alone (no comp, no revoke)", async () => {
    const { svc } = build({
      overrides: [overrideRow({ id: "g", featureKey: "recurring_routes", effect: "GRANT" })],
    });
    const res = await svc.plan(T, "delivery_distributor");
    expect(res.plan.comps.map((c) => c.featureKey)).toEqual(["order_delivery", "driver_payments"]);
    expect(res.revokeOverrideIds).toEqual({});
  });

  it("fleet:false: a COMP row is planned as a disable flagged comp, a paid row keeps its billing stop", async () => {
    const { svc } = build({
      addons: [
        { key: "recurring_routes", paid: true },
        { key: "order_delivery", paid: false, comp: true },
      ],
    });
    const res = await svc.plan(T, "shipping_wholesaler");
    expect(res.plan.billing).toEqual([
      { featureKey: "order_delivery", action: "disable", manual: false, comp: true },
      { featureKey: "recurring_routes", action: "disable", manual: false },
    ]);
    expect(res.plan.overrides.every((o) => o.action === "skip")).toBe(true);
  });
});

describe("SA-671 M1 — an unavailable mode refuses the profile with a CODE, before any read", () => {
  // The in-store modes are AVAILABLE in the registry now (pickup mode API), so the guard is proven by
  // marking the live registry row unavailable for one test (restored in finally).
  const modeRow = (mode: string) =>
    FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes[mode] as {
      available: boolean;
    };
  const withUnavailable = async (mode: string, run: () => Promise<void>) => {
    const row = modeRow(mode);
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
  ])("%s is refused while its mode is unavailable", async (key, mode) => {
    await withUnavailable(mode, async () => {
      const { svc, prisma, featureOverrides, featurePreview } = build();
      const err = await svc.preview(T, key).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: "BUSINESS_PROFILE_UNAVAILABLE",
        unavailable: [expect.objectContaining({ key: "fulfilment_model" })],
      });
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(featureOverrides.list).not.toHaveBeenCalled();
      expect(featurePreview.preview).not.toHaveBeenCalled();
    });
  });

  it("even when the tenant ALREADY stores that mode (an unchanged mode is no bypass)", async () => {
    await withUnavailable("pickup", async () => {
      const { svc } = build({ modes: { fulfilment_model: "pickup", counter_sales: "on" } });
      const err = await svc.plan(T, "in_store_retailer").catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNAVAILABLE" });
    });
  });

  it.each(["in_store_retailer", "in_store_shipping_retailer"])(
    "%s is NOT refused now that the registry offers its mode",
    async (key) => {
      const { svc } = build();
      await expect(svc.plan(T, key)).resolves.toBeDefined();
    },
  );
});

describe("SA SHOULD — a MANUAL-pay add-on", () => {
  it("is planned as a disable flagged manual, and the preview says to remove it from the manual invoice", async () => {
    const { svc } = build({ addons: [{ key: "order_delivery", paid: true, manual: true }] });
    const res = await svc.preview(T, "shipping_wholesaler");
    expect(res.plan.billing).toEqual([
      { featureKey: "order_delivery", action: "disable", manual: true },
    ]);
    expect(res.summary[0]).toBe(
      "Ad hoc order delivery will be switched off; remove it from their manual invoice",
    );
  });
});

describe("Item 8 — a profile that moves the billing moment refuses while carrier orders are in transit", () => {
  it("unset → ship with an order with the carrier: 409 FULFILMENT_CARRIER_IN_TRANSIT, the Settings guard's own", async () => {
    const { svc, prisma, featurePreview } = build({ inTransit: 2 });
    await expect(svc.preview(T, "shipping_wholesaler")).rejects.toMatchObject({
      status: 409,
      response: {
        code: "FULFILMENT_CARRIER_IN_TRANSIT",
        count: 2,
        message:
          "Orders are with the carrier right now. Change the delivery method once they are delivered.",
      },
    });
    await expect(svc.plan(T, "shipping_wholesaler")).rejects.toMatchObject({ status: 409 });
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: T,
        fulfillPath: "SHIP",
        shippedAt: { not: null },
      }),
    });
    expect(featurePreview.preview).not.toHaveBeenCalled();
  });

  it("guard row: no order in transit — the profile previews and plans as today", async () => {
    const { svc } = build({ inTransit: 0 });
    const res = await svc.preview(T, "shipping_wholesaler");
    expect(res.plan.modes).toEqual([{ key: "fulfilment_model", from: "unset", to: "ship" }]);
  });

  it("a profile that keeps the billing moment never counts (ship → ship is no change)", async () => {
    const { svc, prisma } = build({
      inTransit: 3,
      modes: { fulfilment_model: "ship", counter_sales: "unset" },
    });
    await svc.preview(T, "shipping_wholesaler");
    expect(prisma.order.count).not.toHaveBeenCalled();
  });
});
