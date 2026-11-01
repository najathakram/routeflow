/**
 * BO-04 - real Postgres. The capability ticks and the carrier-in-transit rule, end to end:
 *
 *   (a) a ship tenant with one SHIP order shipped and not delivered, ticks {delivery}: the preview is a 200 with
 *       `blocked.count === 1`; the confirm is a 409 FULFILMENT_CARRIER_IN_TRANSIT and writes NOTHING (no add-on,
 *       no override, no config change, no audit row, no billing disable);
 *   (b) a delivery tenant paying for the fleet, ticks {shipping}, one order in transit: 409 and `disableAddon`
 *       is never called, the paid rows stay active (a refusal never leaves billing half stopped);
 *   (c) the Feature Console's `PUT` and `DELETE tenants/:id/feature-config/fulfilment_model` get the same 409
 *       (seam S4) and leave the stored row alone;
 *   (d) re-applying the same ticks writes nothing but one more BUSINESS_PROFILE_APPLIED audit row;
 *   (e) a comp the comp path would refuse is `blocked` (FEATURE_REQUIRES_UNMET) and the confirm stops BEFORE the
 *       billing disable of the paid module.
 *
 * The real BusinessProfileService / FeatureConfigService / AddonService / FeatureOverrideService, the real
 * PlatformAdminController and FeatureConfigController routes, and the REAL `common/db-locks` run over a real
 * Postgres. Stripe is a fake that counts calls; the authority / cache / audit-action recorder are stubs.
 * Throwaway `qa-*` tenants, removed in afterAll. DB lane (`npm run local:test:db`), not run in unit CI.
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { BillingEventService } from "./billing-event.service";
import { BusinessProfileService } from "./business-profile.service";
import { FeatureConfigController } from "./feature-config.controller";
import { FeatureConfigService } from "./feature-config.service";
import { FeatureConfigStore } from "./feature-config.store";
import { FeatureOverrideService } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import * as capabilities from "./business-capabilities";
import { businessProfileByKey } from "./business-profiles";
import { billsAtShipment } from "../orders/order-status-invoicing";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { PlatformAdminController } from "../platform-admin/platform-admin.controller";
import { BusinessProfileApplyService } from "./business-profile-apply.service";
import { BusinessProfileApplyService } from "./business-profile-apply.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const MODULES = ["recurring_routes", "order_delivery", "driver_payments"];
const admin = { sub: "admin-bo04", role: UserRole.SUPER_ADMIN } as any;

describeDb("BO-04 - capability ticks and the carrier-in-transit rule (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let addons: AddonService;
  let controller: PlatformAdminController;
  let consoleController: FeatureConfigController;
  const recordAdminAction = jest.fn().mockResolvedValue(undefined);
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const stripe = {
    isConfigured: true,
    client: {
      subscriptionItems: {
        create: jest.fn(async () => ({ id: `si_bo04_${randomUUID().slice(0, 8)}` })),
        del: jest.fn(async () => ({})),
      },
    },
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    const catalog = new PlanCatalogService(prisma as any);
    const featureOverrides = new FeatureOverrideService(prisma as any);
    addons = new AddonService(
      prisma as any,
      stripe as any,
      { invalidate: jest.fn() } as any, // entitlements (cache only)
      catalog,
      { invalidate: jest.fn() } as any, // featureResolver (cache only)
      { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any, // authority
      new BillingEventService(prisma as any),
      featureOverrides,
    );
    const featureConfig = new FeatureConfigService(
      prisma as any,
      new FeatureConfigStore(prisma as any),
      new AuditService(prisma as any),
      addons,
      { hasFlag: async () => true } as any, // entitlements
      featureOverrides,
    );
    const featurePreview = { preview: async () => ({ before: [], after: [], changed: [] }) };
    const businessProfiles = new BusinessProfileService(
      prisma as any,
      featureOverrides,
      addons,
      featureConfig,
      featurePreview as any,
    );
    const stub = () => ({}) as any;
    const authority = {
      assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(),
    } as any;
    controller = new PlatformAdminController(
      { recordAdminAction } as any, // svc (audit rows are asserted through this recorder)
      stub(), // platformConfig
      stub(), // billingService
      addons,
      featureOverrides,
      stub(), // entitlementsMode
      stub(), // configSnapshotFlag
      stub(), // featureDiffs
      authority,
      featurePreview as any,
      stub(), // snapshotAdmin
      businessProfiles,
      featureConfig,
    );
    consoleController = new FeatureConfigController(featureConfig);
  });

  beforeEach(() => {
    recordAdminAction.mockClear();
    stripe.client.subscriptionItems.create.mockClear();
    stripe.client.subscriptionItems.del.mockClear();
  });

  // spies on the real services/mapping only; the jest.fn() recorders keep their implementations
  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.customer.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** A throwaway tenant, optionally on a stored fulfilment mode, with fleet rows and one order in transit. */
  async function tenant(
    label: string,
    opts: {
      mode?: string;
      paidModules?: string[];
      fleetKey?: boolean;
      inTransit?: number;
    } = {},
  ): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-bo04-${run}-${seq}-${label}`,
      "business-capabilities.db.spec.ts",
    );
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    if (opts.mode) {
      await prisma.tenantFeatureConfig.create({
        data: { tenantId: t.id, featureKey: "fulfilment_model", mode: opts.mode, reason: "seed" },
      });
    }
    for (const key of opts.paidModules ?? []) {
      await prisma.tenantAddon.create({
        data: {
          tenantId: t.id,
          addonKey: key,
          active: true,
          isComp: false,
          stripeItemId: `si_bo04_${run}_${seq}_${key}`,
          priceSnapshot: 49,
        },
      });
    }
    if (opts.fleetKey && !(opts.paidModules ?? []).includes("recurring_routes")) {
      await prisma.tenantAddon.create({
        data: { tenantId: t.id, addonKey: "recurring_routes", active: true, isComp: true },
      });
    }
    if (opts.inTransit) {
      const user = await prisma.user.create({
        data: {
          email: `cust-${slug}@example.invalid`,
          username: `cust-${slug}`,
          role: "CUSTOMER",
          tenantId: t.id,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "Acme Retail", contactName: "c", tenantId: t.id },
      });
      for (let i = 0; i < opts.inTransit; i += 1) {
        await prisma.order.create({
          data: {
            tenantId: t.id,
            customerId: customer.id,
            orderNumber: `ORD-BO04-${run}-${seq}-${i}`,
            fulfillPath: "SHIP",
            status: "OUT_FOR_DELIVERY",
            shippedAt: new Date(),
          },
        });
      }
    }
    return t.id;
  }

  const addonRows = (tenantId: string) =>
    prisma.tenantAddon.findMany({ where: { tenantId, addonKey: { in: MODULES } } });
  const overrideCount = (tenantId: string) =>
    prisma.tenantFeatureOverride.count({ where: { tenantId } });
  const configRows = (tenantId: string) =>
    prisma.tenantFeatureConfig.findMany({ where: { tenantId }, orderBy: { featureKey: "asc" } });
  const appliedRows = () =>
    recordAdminAction.mock.calls.filter((c) => c[2] === AdminAuditAction.BUSINESS_PROFILE_APPLIED);
  const preview = (id: string, ticks: object) =>
    (controller as any).previewBusinessCapabilities(id, ticks);
  const confirm = async (id: string, ticks: object) => {
    const shown = await preview(id, ticks);
    return (controller as any).applyBusinessCapabilities(
      id,
      { ...ticks, planFingerprint: shown.planFingerprint },
      admin,
    );
  };
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return { code: "ok", status: 200 };
    } catch (e) {
      const r = (e as any)?.getResponse?.() ?? {};
      return { code: r.code ?? "other", status: (e as any)?.getStatus?.(), count: r.count };
    }
  };

  it("(a) ship tenant, one order in transit, ticks {delivery}: preview 200 blocked.count 1; confirm 409 and NOTHING is written", async () => {
    const t = await tenant("a", { mode: "ship", inTransit: 1 });
    const disable = jest.spyOn(addons, "disableAddon");
    spies.push(disable);

    const shown = await preview(t, { delivery: true });
    expect(shown.blocked).toEqual({ code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 });
    expect(shown.plan.modes).toEqual([{ key: "fulfilment_model", from: "ship", to: "delivery" }]);

    const res = await codeOf(
      (controller as any).applyBusinessCapabilities(
        t,
        { delivery: true, planFingerprint: shown.planFingerprint },
        admin,
      ),
    );
    expect(res).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409, count: 1 });
    expect(await addonRows(t)).toEqual([]);
    expect(await overrideCount(t)).toBe(0);
    expect((await configRows(t)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["fulfilment_model", "ship"],
    ]);
    expect(disable).not.toHaveBeenCalled();
    expect(appliedRows()).toEqual([]);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
  }, 60_000);

  it("(b) delivery tenant paying for the fleet, ticks {shipping}, one order in transit: 409 before the first billing disable", async () => {
    const t = await tenant("b", { mode: "delivery", paidModules: MODULES, inTransit: 1 });
    const disable = jest.spyOn(addons, "disableAddon");
    spies.push(disable);

    const shown = await preview(t, { shipping: true });
    expect(shown.blocked).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 });
    expect(shown.plan.billing.map((b: { featureKey: string }) => b.featureKey)).toEqual([
      "driver_payments",
      "order_delivery",
      "recurring_routes",
    ]);

    const res = await codeOf(
      (controller as any).applyBusinessCapabilities(
        t,
        { shipping: true, planFingerprint: shown.planFingerprint },
        admin,
      ),
    );
    expect(res).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409 });
    expect(disable).not.toHaveBeenCalled();
    const rows = await addonRows(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.active && r.stripeItemId)).toBe(true);
    expect(stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect((await configRows(t)).map((r) => r.mode)).toEqual(["delivery"]);
  }, 60_000);

  it("(c) PUT and DELETE feature-config/fulfilment_model on a ship tenant with one order in transit: 409 each, the row stays", async () => {
    const t = await tenant("c", { mode: "ship", fleetKey: true, inTransit: 1 });

    const put = await codeOf(
      consoleController.setState(
        t,
        "fulfilment_model",
        { mode: "delivery", reason: "console" },
        admin,
      ),
    );
    expect(put).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409, count: 1 });
    const del = await codeOf(consoleController.clearState(t, "fulfilment_model", admin));
    expect(del).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409, count: 1 });

    expect((await configRows(t)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["fulfilment_model", "ship"],
    ]);
    // a move inside the shipping modes is still allowed, in transit or not
    const ok = await codeOf(
      consoleController.setState(t, "fulfilment_model", { mode: "both", reason: "console" }, admin),
    );
    expect(ok.code).toBe("ok");
  }, 60_000);

  it("(d) re-applying the same ticks writes nothing but one more audit row", async () => {
    // SA-1028: seeded on `ship`, so these ticks write counter_sales (an unset tenant would keep its model unset)
    const t = await tenant("d", { mode: "ship" });
    const ticks = { shipping: true, counter: true, opensAs: "order" as const };

    await confirm(t, ticks);
    const afterFirst = {
      addons: await addonRows(t),
      overrides: await overrideCount(t),
      config: (await configRows(t)).map((r) => [r.featureKey, r.mode, r.updatedAt.toISOString()]),
    };
    expect(afterFirst.config.map((c) => [c[0], c[1]])).toEqual([
      ["counter_sales", "on"],
      ["fulfilment_model", "ship"],
    ]);

    await confirm(t, ticks);
    expect(await addonRows(t)).toEqual(afterFirst.addons);
    expect(await overrideCount(t)).toBe(afterFirst.overrides);
    expect(
      (await configRows(t)).map((r) => [r.featureKey, r.mode, r.updatedAt.toISOString()]),
    ).toEqual(afterFirst.config);
    expect(appliedRows()).toHaveLength(2);
    expect(appliedRows()[1][3]).toMatchObject({
      preset: null,
      capabilities: { shipping: true, counter: true, opensAs: "order" },
    });
  }, 60_000);

  it("(e) a comp the comp path would refuse is `blocked`; the confirm stops BEFORE the paid module's billing disable", async () => {
    const t = await tenant("e", { paidModules: ["recurring_routes"] });
    const disable = jest.spyOn(addons, "disableAddon");
    spies.push(disable);
    // door payments wanted with no fleet key anywhere: ticks cannot produce this def today, so it is handed to
    // the real planner and apply through the mapping
    const odd = {
      ...businessProfileByKey("shipping_wholesaler")!,
      key: "custom",
      modules: { driver_payments: true },
    };
    spies.push(
      jest.spyOn(capabilities, "ticksToProfileDef").mockImplementation(() => ({
        def: odd,
        normalised: capabilities.presetTicks(odd),
        preset: null,
      })),
    );

    const shown = await preview(t, { counter: true });
    expect(shown.blocked).toMatchObject({ code: "FEATURE_REQUIRES_UNMET", key: "driver_payments" });
    const res = await codeOf(
      (controller as any).applyBusinessCapabilities(
        t,
        { counter: true, planFingerprint: shown.planFingerprint },
        admin,
      ),
    );
    expect(res).toMatchObject({ code: "FEATURE_REQUIRES_UNMET", status: 400 });
    expect(disable).not.toHaveBeenCalled();
    const rows = await addonRows(t);
    expect(rows.map((r) => [r.addonKey, r.active])).toEqual([["recurring_routes", true]]);
    expect(stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(await configRows(t)).toEqual([]);
    expect(appliedRows()).toEqual([]);
  }, 60_000);

  // ── SA-1028: a "not set up" (fulfilment_model unset) tenant with SHIP orders in transit ─────────────────────
  // The owner case: the card read an unset tenant as nothing ticked, so adding Counter sent Delivery + Shipping off
  // and wrote fulfilment_model, which the carrier-in-transit rule (kept) refused. The card now reads today's ticks
  // and the keep rule leaves the stored model unset, so Counter alone goes through; invoicing stays at delivery.
  const modeReader = (tenantId: string) => ({
    getEffectiveMode: async (_t: string, key: string) =>
      (await configRows(tenantId)).find((r) => r.featureKey === key)?.mode ?? "unset",
  });

  it("K-R2: unset + fleet held + SHIP in transit: the card plus Counter changes counter_sales only; no model row, no billing, no 409", async () => {
    const t = await tenant("r2", { paidModules: MODULES, inTransit: 1 });
    const disable = jest.spyOn(addons, "disableAddon");
    spies.push(disable);

    const card = await (controller as any).getBusinessCapabilities(t);
    expect(card).toMatchObject({
      configured: false,
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: false,
    });
    const ticks = {
      delivery: card.delivery,
      doorPayments: card.doorPayments,
      shipping: card.shipping,
      counter: true,
    };

    const shown = await preview(t, ticks);
    expect(shown.blocked).toBeNull();
    expect(shown.plan.modes).toEqual([{ key: "counter_sales", from: "unset", to: "on" }]);

    const done = await confirm(t, ticks);
    expect(done.preset).toBeNull();
    expect((await configRows(t)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["counter_sales", "on"],
    ]);
    expect(await overrideCount(t)).toBe(0);
    const rows = await addonRows(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.active && !r.isComp && r.stripeItemId)).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    expect(stripe.client.subscriptionItems.del).not.toHaveBeenCalled();

    // invoicing stays at delivery: the SHIP order does not bill at shipment (the model is still unset)
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: t } });
    expect(await billsAtShipment(modeReader(t), t, order)).toBe(false);
    // and the card still says "not set up", now with Counter ticked
    expect(await (controller as any).getBusinessCapabilities(t)).toMatchObject({
      configured: false,
      counter: true,
      shipping: true,
      delivery: true,
    });
  }, 60_000);

  it("K-R2: the same holds with no fleet (Shipping only): Counter added, still no model row", async () => {
    const t = await tenant("r2b", { inTransit: 1 });
    const card = await (controller as any).getBusinessCapabilities(t);
    expect(card).toMatchObject({ configured: false, delivery: false, shipping: true });
    const ticks = { shipping: true, counter: true, opensAs: card.opensAs };
    const shown = await preview(t, ticks);
    expect(shown.blocked).toBeNull();
    expect(shown.plan.modes).toEqual([{ key: "counter_sales", from: "unset", to: "on" }]);
    await confirm(t, ticks);
    expect((await configRows(t)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["counter_sales", "on"],
    ]);
  }, 60_000);

  it("K-G1: unticking Delivery on that tenant is a real move to ship: still refused 409 with the order in transit, nothing written", async () => {
    const t = await tenant("g1", { paidModules: MODULES, inTransit: 1 });
    const disable = jest.spyOn(addons, "disableAddon");
    spies.push(disable);
    const ticks = { shipping: true, counter: true };

    const shown = await preview(t, ticks);
    expect(shown.blocked).toEqual({ code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 });
    expect(shown.plan.modes).toEqual(
      expect.arrayContaining([{ key: "fulfilment_model", from: "unset", to: "pickup_ship" }]),
    );
    const res = await codeOf(
      (controller as any).applyBusinessCapabilities(
        t,
        { ...ticks, planFingerprint: shown.planFingerprint },
        admin,
      ),
    );
    expect(res).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409, count: 1 });
    expect(await configRows(t)).toEqual([]);
    expect(disable).not.toHaveBeenCalled();
    expect((await addonRows(t)).every((r) => r.active)).toBe(true);
  }, 60_000);

  it("K-G2: unticking Shipping carries the model (unset -> delivery); it moves no billing moment, so it is allowed", async () => {
    const t = await tenant("g2", { paidModules: MODULES, inTransit: 1 });
    const shown = await preview(t, { delivery: true, doorPayments: true, counter: true });
    expect(shown.blocked).toBeNull();
    expect(shown.plan.modes).toEqual(
      expect.arrayContaining([{ key: "fulfilment_model", from: "unset", to: "delivery" }]),
    );
  }, 60_000);

  it("K-G4: the Feature Console PUT counter_sales on with SHIP in transit is allowed (200) on that tenant", async () => {
    const t = await tenant("g4", { inTransit: 1 });
    const res = await codeOf(
      consoleController.setState(t, "counter_sales", { mode: "on", reason: "console" }, admin),
    );
    expect(res.code).toBe("ok");
    expect((await configRows(t)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["counter_sales", "on"],
    ]);
  }, 60_000);

  it("K-G5: a preset apply still moves the model: refused 409 with the order in transit, nothing written", async () => {
    const t = await tenant("g5", { inTransit: 1 });
    const res = await codeOf(
      (controller as any).applyBusinessProfile(
        t,
        { profile: "shipping_wholesaler", planFingerprint: "not-checked-before-the-block" },
        admin,
      ),
    );
    expect(res).toMatchObject({ code: "FULFILMENT_CARRIER_IN_TRANSIT", status: 409 });
    expect(await configRows(t)).toEqual([]);
  }, 60_000);
});
