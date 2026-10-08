/**
 * Settings -> Fulfilment (PR1, dark behind FULFILMENT_SELF_SERVE): `GET /settings/fulfilment`,
 * `POST /settings/fulfilment/preview`, `PATCH /settings/fulfilment`.
 *
 * Runs the REAL SettingsFulfilmentService / FeatureConfigService / FeatureConfigStore and the real
 * RolesGuard over an in-memory tenant world (`testing/fulfilment-world.ts`) whose
 * `tenantTransaction` really rolls back. The advisory lock is the in-process double
 * (`testing/lock-mock.ts`), so the ORDER lock -> tx -> commit -> invalidate -> unlock is asserted.
 * Real-Postgres proof (rollback, isolation, concurrency) is `settings-fulfilment.db.spec.ts`.
 */
import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { UNSET_FULFILMENT_CAPABILITIES } from "@routeflow/types";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { FLEET_KEYS } from "../billing/fulfilment-capability";
import { FulfilmentEditGuard, canEditFulfilment } from "./fulfilment-edit";
import { SettingsFulfilmentController } from "./settings-fulfilment.controller";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";
import {
  createWorld,
  OTHER_TENANT_ID,
  TENANT_ID,
  type WorldOptions,
} from "./testing/fulfilment-world";
import { lockState, resetLockState } from "./testing/lock-mock";

jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.requireActual("./testing/lock-mock").fakeWithAdvisoryLock,
}));

const user = (role: string, over: Partial<JwtPayload> = {}): JwtPayload =>
  ({
    sub: `u-${role.toLowerCase()}`,
    username: role === "TENANT_ADMIN" ? "ada" : role.toLowerCase(),
    role,
    tenantId: TENANT_ID,
    tenantSlug: "qa-acme",
    ...over,
  }) as JwtPayload;
const admin = user("TENANT_ADMIN");
const operator = user("OPERATOR");

const ENV_KEYS = ["FULFILMENT_SELF_SERVE", "FULFILMENT_SELF_SERVE_TENANTS"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FULFILMENT_SELF_SERVE = "on";
  delete process.env.FULFILMENT_SELF_SERVE_TENANTS;
  resetLockState();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

function build(opts: WorldOptions = {}) {
  const world = createWorld(opts);
  const service = new SettingsFulfilmentService(
    world.prisma,
    world.featureConfig,
    world.store,
    world.addonService,
    world.featureOverrides,
  );
  const controller = new SettingsFulfilmentController(service);
  return { ...world, service, controller };
}

async function bodyOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return { status: (e as any).getStatus(), ...(e as any).getResponse() };
  }
  throw new Error("expected a rejection");
}

const ctxFor = (handler: (...a: any[]) => any, u: Partial<JwtPayload>): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => SettingsFulfilmentController,
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
  }) as unknown as ExecutionContext;

const OPEN = "PENDING";
const order = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID,
  fulfillPath: "ROUTE" as const,
  status: OPEN,
  ...over,
});

describe("roles (real RolesGuard + the one edit predicate)", () => {
  const rolesGuard = new RolesGuard(new Reflector());
  const editGuard = new FulfilmentEditGuard();
  const proto = SettingsFulfilmentController.prototype;
  const can = (h: (...a: any[]) => any, u: JwtPayload) => rolesGuard.canActivate(ctxFor(h, u));

  it("GET: TENANT_ADMIN, OPERATOR and SUPER_ADMIN pass; DRIVER and CUSTOMER are refused", () => {
    expect(can(proto.get, admin)).toBe(true);
    expect(can(proto.get, operator)).toBe(true);
    expect(can(proto.get, user("SUPER_ADMIN"))).toBe(true);
    expect(can(proto.get, user("DRIVER"))).toBe(false);
    expect(can(proto.get, user("CUSTOMER"))).toBe(false);
    expect(Reflect.getMetadata("roles", proto.get)).toEqual([UserRole.OPERATOR]);
  });

  it.each(["preview", "update"] as const)("%s: @Roles(TENANT_ADMIN) refuses OPERATOR", (name) => {
    expect(Reflect.getMetadata("roles", proto[name])).toEqual([UserRole.TENANT_ADMIN]);
    expect(can(proto[name], admin)).toBe(true);
    expect(can(proto[name], operator)).toBe(false);
    expect(can(proto[name], user("DRIVER"))).toBe(false);
    expect(can(proto[name], user("CUSTOMER"))).toBe(false);
  });

  it.each(["preview", "update"] as const)(
    "%s: the edit guard is wired and is the canEditFulfilment predicate",
    (name) => {
      const guards: unknown[] = Reflect.getMetadata("__guards__", proto[name]) ?? [];
      expect(guards).toContain(FulfilmentEditGuard);
      for (const role of ["TENANT_ADMIN", "OPERATOR", "DRIVER", "CUSTOMER"]) {
        expect(editGuard.canActivate(ctxFor(proto[name], user(role)))).toBe(
          canEditFulfilment(user(role)),
        );
      }
      expect(canEditFulfilment(admin)).toBe(true);
      expect(canEditFulfilment(operator)).toBe(false);
    },
  );

  it("GET's canEdit is selfServe AND the same predicate", async () => {
    const w = build();
    expect((await w.controller.get(admin)).canEdit).toBe(canEditFulfilment(admin));
    expect((await w.controller.get(operator)).canEdit).toBe(canEditFulfilment(operator));
    process.env.FULFILMENT_SELF_SERVE = "off";
    expect((await w.controller.get(admin)).canEdit).toBe(false);
  });

  it("the route prefix is settings/fulfilment and preview is its own sub-path", () => {
    expect(Reflect.getMetadata("path", SettingsFulfilmentController)).toBe("settings/fulfilment");
    expect(Reflect.getMetadata("path", proto.preview)).toBe("preview");
  });
});

describe("GET /settings/fulfilment", () => {
  it("an unset tenant reads unset / off and EXACTLY today's capability", async () => {
    const w = build({ fleet: true });
    const g = await w.controller.get(admin);
    expect(g.fulfilmentModel.value).toBe("unset");
    expect(g.fulfilmentModel.effective).toBe("unset");
    expect(g.counterSales).toEqual({ value: "off", effective: "off" });
    expect(g.capability).toEqual(UNSET_FULFILMENT_CAPABILITIES);
    expect(g.selfServe).toBe(true);
    expect(g.canEdit).toBe(true);
    expect(g.lastChange).toBeNull();
    expect(g.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("options come in display order with selectable from the fleet", async () => {
    const w = build({ fleet: true });
    const { options } = (await w.controller.get(admin)).fulfilmentModel;
    expect(options.map((o) => o.key)).toEqual([
      "delivery",
      "ship",
      "both",
      "pickup",
      "pickup_ship",
      "unset",
    ]);
    const by = Object.fromEntries(options.map((o) => [o.key, o]));
    for (const k of ["delivery", "ship", "both", "unset"]) {
      expect(by[k]).toMatchObject({ selectable: true });
      expect(by[k].blockedBy).toBeUndefined();
    }
    for (const o of options) expect(typeof o.label).toBe("string");
  });

  it("without a fleet delivery and both are blocked by the plan; ship and unset stay open", async () => {
    const w = build({ fleet: false });
    const { options } = (await w.controller.get(admin)).fulfilmentModel;
    const by = Object.fromEntries(options.map((o) => [o.key, o]));
    expect(by.delivery).toMatchObject({ selectable: false, blockedBy: "plan" });
    expect(by.both).toMatchObject({ selectable: false, blockedBy: "plan" });
    expect(by.ship.selectable).toBe(true);
    expect(by.unset.selectable).toBe(true);
  });

  it("the pickup modes are blocked as 'proposed' for a tenant outside the pilot allowlist", async () => {
    const w = build({ fleet: true });
    const by = Object.fromEntries(
      (await w.controller.get(admin)).fulfilmentModel.options.map((o) => [o.key, o]),
    );
    expect(by.pickup).toMatchObject({ selectable: false, blockedBy: "proposed" });
    expect(by.pickup_ship).toMatchObject({ selectable: false, blockedBy: "proposed" });
  });

  it("the pickup modes are selectable for an allowlisted pilot tenant", async () => {
    process.env.FULFILMENT_SELF_SERVE = "allowlist";
    process.env.FULFILMENT_SELF_SERVE_TENANTS = "qa-acme";
    const w = build({ fleet: true });
    const by = Object.fromEntries(
      (await w.controller.get(admin)).fulfilmentModel.options.map((o) => [o.key, o]),
    );
    expect(by.pickup.selectable).toBe(true);
    expect(by.pickup_ship.selectable).toBe(true);
  });

  it("an unavailable registry mode is never selectable", async () => {
    const mode = FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes.ship;
    const was = mode.available;
    (mode as { available: boolean }).available = false;
    try {
      const w = build({ fleet: true });
      const by = Object.fromEntries(
        (await w.controller.get(admin)).fulfilmentModel.options.map((o) => [o.key, o]),
      );
      expect(by.ship.selectable).toBe(false);
    } finally {
      (mode as { available: boolean }).available = was;
    }
  });

  it("a stored ship mode with counter on reads ship / on / optional", async () => {
    const w = build({
      fleet: true,
      rows: [
        { featureKey: "fulfilment_model", mode: "ship" },
        { featureKey: "counter_sales", mode: "on" },
      ],
    });
    const g = await w.controller.get(admin);
    expect(g.fulfilmentModel).toMatchObject({ value: "ship", effective: "ship" });
    expect(g.counterSales).toEqual({ value: "on", effective: "optional" });
    expect(g.capability.methods).toEqual(["SHIP"]);
  });

  it("an in-store mode reads the counter as always on, whatever the stored switch says", async () => {
    const w = build({ fleet: true, rows: [{ featureKey: "fulfilment_model", mode: "pickup" }] });
    expect((await w.controller.get(admin)).counterSales).toEqual({
      value: "off",
      effective: "always",
    });
  });

  it("an OPERATOR reads but cannot edit; a dark flag turns selfServe and canEdit off", async () => {
    const w = build();
    expect(await w.controller.get(operator)).toMatchObject({ selfServe: true, canEdit: false });
    process.env.FULFILMENT_SELF_SERVE = "off";
    expect(await w.controller.get(admin)).toMatchObject({ selfServe: false, canEdit: false });
    delete process.env.FULFILMENT_SELF_SERVE;
    expect(await w.controller.get(admin)).toMatchObject({ selfServe: false, canEdit: false });
  });

  it("a failed fleet read is the 503 FEATURES_UNAVAILABLE, never a guessed answer", async () => {
    const w = build({ failFleet: true });
    const e = await bodyOf(w.controller.get(admin));
    expect(e.status).toBe(503);
    expect(e.code).toBe(API_ERROR_CODES.FEATURES_UNAVAILABLE);
  });

  it("the fingerprint is stable, and moves with the stored mode, the counter and the fleet", async () => {
    const a = (await build({ fleet: true }).controller.get(admin)).fingerprint;
    expect((await build({ fleet: true }).controller.get(admin)).fingerprint).toBe(a);
    const ship = await build({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
    }).controller.get(admin);
    const counter = await build({
      fleet: true,
      rows: [{ featureKey: "counter_sales", mode: "on" }],
    }).controller.get(admin);
    const noFleet = await build({ fleet: false }).controller.get(admin);
    expect(new Set([a, ship.fingerprint, counter.fingerprint, noFleet.fingerprint]).size).toBe(4);
  });

  it("refuses a caller whose token tenant is not the request's tenant (403) before any read", async () => {
    const w = build();
    const e = await bodyOf(w.controller.get(user("TENANT_ADMIN", { tenantId: OTHER_TENANT_ID })));
    expect(e.status).toBe(403);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_TENANT_MISMATCH);
    expect(e.code).toBe("FULFILMENT_TENANT_MISMATCH");
    expect(w.prisma.tenantFeatureConfig.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a request with no tenant context (403 TENANT_CONTEXT_REQUIRED) before any read", async () => {
    const w = build({ tenantId: null });
    const e = await bodyOf(w.controller.get(user("SUPER_ADMIN", { tenantId: null })));
    expect(e.status).toBe(403);
    expect(e.code).toBe(API_ERROR_CODES.TENANT_CONTEXT_REQUIRED);
    expect(w.prisma.tenantFeatureConfig.findUnique).not.toHaveBeenCalled();
    expect(w.prisma.tenantFeatureConfig.findMany).not.toHaveBeenCalled();
  });
});

describe("lastChange (M3)", () => {
  const T1 = new Date("2026-10-02T09:00:00.000Z");
  const T2 = new Date("2026-10-05T09:00:00.000Z");
  const tenantAdmin = { id: "u-ada", tenantId: TENANT_ID, role: "TENANT_ADMIN", username: "ada" };

  it("is null when the tenant has never been configured", async () => {
    expect((await build().controller.get(admin)).lastChange).toBeNull();
  });

  it("names a non-super-admin user of THIS tenant as the business, at the latest updatedAt", async () => {
    const w = build({
      users: [tenantAdmin],
      rows: [
        { featureKey: "fulfilment_model", mode: "ship", updatedById: "u-ada", updatedAt: T1 },
        { featureKey: "counter_sales", mode: "on", updatedById: "u-ada", updatedAt: T2 },
      ],
    });
    expect((await w.controller.get(admin)).lastChange).toEqual({
      at: T2.toISOString(),
      by: "business",
      name: "ada",
    });
  });

  it("the LATEST row decides who changed it", async () => {
    const w = build({
      users: [tenantAdmin],
      rows: [
        { featureKey: "fulfilment_model", mode: "ship", updatedById: "u-ada", updatedAt: T1 },
        { featureKey: "counter_sales", mode: "on", updatedById: "sa-1", updatedAt: T2 },
      ],
    });
    expect((await w.controller.get(admin)).lastChange).toEqual({
      at: T2.toISOString(),
      by: "routeflow",
      name: null,
    });
  });

  it("after a platform PUT (Feature Console set) it reads routeflow with no name", async () => {
    const w = build({
      fleet: true,
      users: [tenantAdmin, { id: "sa-1", tenantId: null, role: "SUPER_ADMIN", username: "root" }],
      rows: [{ featureKey: "fulfilment_model", mode: "ship", updatedById: "u-ada", updatedAt: T1 }],
    });
    await w.featureConfig.set(TENANT_ID, "fulfilment_model", "both", "console", "sa-1");
    expect((await w.controller.get(admin)).lastChange).toMatchObject({
      by: "routeflow",
      name: null,
    });
  });

  it.each([
    ["a SUPER_ADMIN of this tenant", { id: "u-x", tenantId: TENANT_ID, role: "SUPER_ADMIN" }],
    ["a user of ANOTHER tenant", { id: "u-x", tenantId: OTHER_TENANT_ID, role: "TENANT_ADMIN" }],
    ["a user that no longer exists", { id: "u-gone", tenantId: TENANT_ID, role: "TENANT_ADMIN" }],
  ])("%s is routeflow, never a name", async (_n, u) => {
    const w = build({
      users: u.id === "u-gone" ? [] : [{ ...u, username: "someone" }],
      rows: [{ featureKey: "fulfilment_model", mode: "ship", updatedById: "u-x", updatedAt: T1 }],
    });
    expect((await w.controller.get(admin)).lastChange).toEqual({
      at: T1.toISOString(),
      by: "routeflow",
      name: null,
    });
  });

  it("looks the user up scoped to the tenant", async () => {
    const w = build({
      users: [tenantAdmin],
      rows: [{ featureKey: "fulfilment_model", mode: "ship", updatedById: "u-ada", updatedAt: T1 }],
    });
    await w.controller.get(admin);
    expect(w.prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "u-ada", tenantId: TENANT_ID }),
      }),
    );
    for (const [arg] of w.prisma.tenantFeatureConfig.findMany.mock.calls) {
      expect(arg.where.tenantId).toBe(TENANT_ID);
    }
  });
});

describe("POST /settings/fulfilment/preview", () => {
  it("writes nothing: no row, no audit, no lock, no transaction", async () => {
    const w = build({ fleet: true });
    await w.controller.preview({ fulfilmentModel: "ship", counterSales: "on" }, admin);
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
    expect(w.prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    expect(w.calls.txOpened).toBe(0);
    expect(lockState.calls).toEqual([]);
  });

  it("returns the change, the fingerprint GET serves, and the shape the dialog renders", async () => {
    const w = build({ fleet: true });
    const p = await w.controller.preview({ fulfilmentModel: "ship" }, admin);
    expect(p.changes).toEqual([{ key: "fulfilmentModel", from: "unset", to: "ship" }]);
    expect(p.fingerprint).toBe((await w.controller.get(admin)).fingerprint);
    expect(Array.isArray(p.effects)).toBe(true);
    expect(Array.isArray(p.notChanged)).toBe(true);
  });

  it("a request that matches what is stored changes nothing (symmetric for the counter: unset == off)", async () => {
    const w = build({ fleet: true });
    const p = await w.controller.preview({ fulfilmentModel: "unset", counterSales: "off" }, admin);
    expect(p.changes).toEqual([]);
    expect(p.effects).toEqual([]);
  });

  it.each([
    ["an empty body", {}, "fulfilmentModel"],
    ["a null body", null, "fulfilmentModel"],
    ["an array body", [], "fulfilmentModel"],
    ["a string body", "ship", "fulfilmentModel"],
    ["an unknown mode", { fulfilmentModel: "teleport" }, "fulfilmentModel"],
    ["a non-string mode", { fulfilmentModel: 3 }, "fulfilmentModel"],
    ["a counter value that is not on/off", { counterSales: "maybe" }, "counterSales"],
    ["the stored 'unset' spelling for the counter", { counterSales: "unset" }, "counterSales"],
    ["a boolean counter", { counterSales: true }, "counterSales"],
  ])("%s is a coded 400 naming the field", async (_n, body, field) => {
    const w = build({ fleet: true });
    const e = await bodyOf(w.controller.preview(body as never, admin));
    expect(e.status).toBe(400);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTING_INVALID);
    expect(e.details).toEqual({ field });
  });

  it("a mode the registry marks unavailable is a coded 400", async () => {
    const mode = FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes.both;
    const was = mode.available;
    (mode as { available: boolean }).available = false;
    try {
      const e = await bodyOf(
        build({ fleet: true }).controller.preview({ fulfilmentModel: "both" }, admin),
      );
      expect(e.status).toBe(400);
      expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTING_INVALID);
      expect(e.details).toEqual({ field: "fulfilmentModel" });
    } finally {
      (mode as { available: boolean }).available = was;
    }
  });

  it("a pickup mode outside the pilot allowlist is a coded 400 while the registry says proposed", async () => {
    const e = await bodyOf(
      build({ fleet: true }).controller.preview({ fulfilmentModel: "pickup" }, admin),
    );
    expect(e.status).toBe(400);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTING_INVALID);
    expect(e.details).toEqual({ field: "fulfilmentModel" });
  });

  it("a pickup mode is accepted for an allowlisted pilot", async () => {
    process.env.FULFILMENT_SELF_SERVE = "allowlist";
    process.env.FULFILMENT_SELF_SERVE_TENANTS = "qa-acme";
    const p = await build({ fleet: true }).controller.preview({ fulfilmentModel: "pickup" }, admin);
    expect(p.changes).toEqual([{ key: "fulfilmentModel", from: "unset", to: "pickup" }]);
  });

  it("a counter switch together with an in-store mode is a coded 400 (the counter is always on)", async () => {
    process.env.FULFILMENT_SELF_SERVE = "allowlist";
    process.env.FULFILMENT_SELF_SERVE_TENANTS = "qa-acme";
    const e = await bodyOf(
      build({ fleet: true }).controller.preview(
        { fulfilmentModel: "pickup", counterSales: "off" },
        admin,
      ),
    );
    expect(e.status).toBe(400);
    expect(e.details).toEqual({ field: "counterSales" });
  });

  it("own delivery without a fleet is the 409 FULFILMENT_MODE_NEEDS_FLEET the console uses", async () => {
    const e = await bodyOf(
      build({ fleet: false }).controller.preview({ fulfilmentModel: "delivery" }, admin),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET);
    expect(e.missing).toEqual([...FLEET_KEYS]);
  });

  it("dark: 403 FULFILMENT_SELF_SERVE_OFF and nothing is read", async () => {
    process.env.FULFILMENT_SELF_SERVE = "off";
    const w = build({ fleet: true });
    const e = await bodyOf(w.controller.preview({ fulfilmentModel: "ship" }, admin));
    expect(e.status).toBe(403);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SELF_SERVE_OFF);
    expect(w.prisma.order.count).not.toHaveBeenCalled();
  });

  it("refuses a token tenant that differs from the request tenant", async () => {
    const e = await bodyOf(
      build({ fleet: true }).controller.preview(
        { fulfilmentModel: "ship" },
        user("TENANT_ADMIN", { tenantId: OTHER_TENANT_ID }),
      ),
    );
    expect(e.status).toBe(403);
  });

  describe("effects (counts come from tenant-scoped aggregate queries)", () => {
    const orders = [
      order(),
      order(),
      order({ status: "OUT_FOR_DELIVERY" }),
      order({ status: "DELIVERED" }), // closed: not counted
      order({ status: "CANCELLED" }), // closed: not counted
      order({ tenantId: OTHER_TENANT_ID }), // another tenant: not counted
      order({ fulfillPath: "SHIP" }),
      order({ fulfillPath: "SHIP", status: "DELIVERED" }),
    ];
    const world = () => build({ fleet: true, orders, templates: 2 });
    const codes = (p: { effects: Array<{ code: string }> }) => p.effects.map((e) => e.code);
    const count = (p: { effects: Array<{ code: string; count: number }> }, code: string) =>
      p.effects.find((e) => e.code === code)?.count;

    it("unset -> ship: 3 open route orders, 2 standing orders, 1 open carrier order", async () => {
      const p = await world().controller.preview({ fulfilmentModel: "ship" }, admin);
      expect(count(p, "OPEN_ROUTE_ORDERS")).toBe(3);
      expect(count(p, "TEMPLATES_PATH_CHANGES")).toBe(2);
      expect(count(p, "BILLING_MOMENT")).toBe(1);
      expect(codes(p)).toContain("PORTAL_CHOICE");
      expect(codes(p)).not.toContain("NEW_ORDER_OPENS");
      for (const e of p.effects) {
        expect(typeof e.text).toBe("string");
        expect(e.text.length).toBeGreaterThan(10);
      }
    });

    it("the standing-orders sentence does not promise a path: a customer's saved delivery method still wins", async () => {
      const p = await world().controller.preview({ fulfilmentModel: "ship" }, admin);
      const text = p.effects.find((e) => e.code === "TEMPLATES_PATH_CHANGES")!.text;
      expect(text).toMatch(/\bcan\b|\bmay\b/i);
      expect(text).toMatch(/saved delivery method/i);
    });

    it("every count query is scoped to the caller's tenant", async () => {
      const w = world();
      await w.controller.preview({ fulfilmentModel: "ship" }, admin);
      expect(w.calls.count.length).toBeGreaterThan(0);
      for (const c of w.calls.count) expect(c.where.tenantId).toBe(TENANT_ID);
    });

    it("unset -> delivery loses nothing and crosses no billing moment", async () => {
      const p = await world().controller.preview({ fulfilmentModel: "delivery" }, admin);
      expect(codes(p)).not.toContain("OPEN_ROUTE_ORDERS");
      expect(codes(p)).not.toContain("BILLING_MOMENT");
    });

    it("ship -> both keeps trucks and carrier: no billing change (both ship)", async () => {
      const w = build({
        fleet: true,
        orders,
        templates: 2,
        rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      });
      const p = await w.controller.preview({ fulfilmentModel: "both" }, admin);
      expect(codes(p)).not.toContain("BILLING_MOMENT");
    });

    it("ship -> delivery bills at delivery from now on", async () => {
      const w = build({
        fleet: true,
        orders,
        rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      });
      const p = await w.controller.preview({ fulfilmentModel: "delivery" }, admin);
      expect(codes(p)).toContain("BILLING_MOMENT");
      expect(p.effects.find((e) => e.code === "BILLING_MOMENT")!.text).toMatch(/deliver/i);
    });

    it("in-store: New Order opens the counter and the counter opens", async () => {
      process.env.FULFILMENT_SELF_SERVE = "allowlist";
      process.env.FULFILMENT_SELF_SERVE_TENANTS = "qa-acme";
      const p = await world().controller.preview({ fulfilmentModel: "pickup" }, admin);
      expect(codes(p)).toEqual(expect.arrayContaining(["NEW_ORDER_OPENS", "COUNTER_OPENS"]));
    });

    it("counter off -> on opens it; on -> off closes it", async () => {
      const on = await build({ fleet: true }).controller.preview({ counterSales: "on" }, admin);
      expect(codes(on)).toEqual(["COUNTER_OPENS"]);
      const off = await build({
        fleet: true,
        rows: [{ featureKey: "counter_sales", mode: "on" }],
      }).controller.preview({ counterSales: "off" }, admin);
      expect(codes(off)).toEqual(["COUNTER_CLOSES"]);
    });

    it("notChanged always says orders, customers and routes/add-ons stay", async () => {
      const p = await world().controller.preview({ fulfilmentModel: "ship" }, admin);
      expect(p.notChanged).toEqual(
        expect.arrayContaining([
          "Existing orders keep their delivery method.",
          "Customers keep their saved delivery method.",
          "Routes, drivers and your add-ons are not changed.",
        ]),
      );
    });

    it("leaving own delivery while still holding Routes says you still pay for it", async () => {
      const w = build({
        fleet: true,
        rows: [{ featureKey: "fulfilment_model", mode: "delivery" }],
      });
      const p = await w.controller.preview({ fulfilmentModel: "ship" }, admin);
      expect(p.notChanged).toContain(
        "You still pay for Routes. To stop it, change your plan in Plan & Billing.",
      );
      const none = await build({ fleet: true }).controller.preview(
        { fulfilmentModel: "ship" },
        admin,
      );
      expect(none.notChanged.join(" ")).not.toMatch(/still pay/);
    });
  });
});

describe("PATCH /settings/fulfilment", () => {
  const fp = async (w: ReturnType<typeof build>) => (await w.controller.get(admin)).fingerprint;

  it("dark: 403 FULFILMENT_SELF_SERVE_OFF, nothing taken, nothing written", async () => {
    process.env.FULFILMENT_SELF_SERVE = "off";
    const w = build({ fleet: true });
    const e = await bodyOf(
      w.controller.update({ fulfilmentModel: "ship", fingerprint: "0123456789abcdef" }, admin),
    );
    expect(e.status).toBe(403);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SELF_SERVE_OFF);
    expect(lockState.calls).toEqual([]);
    expect(w.rowCount()).toBe(0);
  });

  it.each([
    ["no fields", { fingerprint: "0123456789abcdef" }, "fulfilmentModel"],
    ["an empty body", {}, "fulfilmentModel"],
    ["a missing fingerprint", { fulfilmentModel: "ship" }, "fingerprint"],
    ["a non-string fingerprint", { fulfilmentModel: "ship", fingerprint: 7 }, "fingerprint"],
    [
      "an unknown mode",
      { fulfilmentModel: "teleport", fingerprint: "0123456789abcdef" },
      "fulfilmentModel",
    ],
    [
      "a bad counter",
      { counterSales: "sometimes", fingerprint: "0123456789abcdef" },
      "counterSales",
    ],
  ])("%s is a coded 400 and writes nothing", async (_n, body, field) => {
    const w = build({ fleet: true });
    const e = await bodyOf(w.controller.update(body as never, admin));
    expect(e.status).toBe(400);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTING_INVALID);
    expect(e.details).toEqual({ field });
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
  });

  it("writes the mode with the console-compatible row and ONE in-tx audit", async () => {
    const w = build({ fleet: true });
    const fingerprint = await fp(w);
    const out = await w.controller.update({ fulfilmentModel: "ship", fingerprint }, admin);

    expect(w.row("fulfilment_model")).toMatchObject({
      tenantId: TENANT_ID,
      mode: "ship",
      reason: "Changed in Settings → Fulfillment",
      updatedById: "u-tenant_admin",
    });
    expect(w.state.audits).toEqual([
      {
        tenantId: TENANT_ID,
        userId: "u-tenant_admin",
        impersonatedBy: null,
        action: "FEATURE_CONFIG_SET",
        entityType: "TenantFeatureConfig",
        entityId: "fulfilment_model",
        meta: {
          key: "fulfilment_model",
          from: "unset",
          to: "ship",
          mode: "ship",
          via: "tenant_settings",
          fingerprint,
        },
      },
    ]);
    // Awaited, in the same tx: NOT the swallow-on-failure AuditService.log.
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(out.changed).toBe(true);
    expect(out.fulfilmentModel).toMatchObject({ value: "ship", effective: "ship" });
    expect(out.fingerprint).not.toBe(fingerprint);
  });

  it("takes the fulfilment-settings lock BEFORE the transaction, commits, invalidates, then unlocks", async () => {
    const w = build({ fleet: true });
    jest.spyOn(w.store, "invalidate").mockImplementation((t: string, k: string) => {
      lockState.events.push(`invalidate:${t}:${k}`);
    });
    const fingerprint = await fp(w);
    await w.controller.update({ fulfilmentModel: "ship", fingerprint }, admin);

    expect(lockState.calls).toEqual([
      expect.objectContaining({ family: "fulfilment-settings", key: TENANT_ID, mode: "wait" }),
    ]);
    const ev = lockState.events;
    const at = (e: string) => ev.indexOf(e);
    const lock = `fulfilment-settings:${TENANT_ID}`;
    expect(at(`lock:acquire:${lock}`)).toBeGreaterThanOrEqual(0);
    expect(at(`lock:acquire:${lock}`)).toBeLessThan(at("tx:open"));
    expect(at("tx:open")).toBeLessThan(at("tx:upsert:fulfilment_model"));
    expect(at("tx:upsert:fulfilment_model")).toBeLessThan(at("tx:audit:fulfilment_model"));
    expect(at("tx:audit:fulfilment_model")).toBeLessThan(at("tx:commit"));
    expect(at("tx:commit")).toBeLessThan(at(`invalidate:${TENANT_ID}:fulfilment_model`));
    expect(at(`invalidate:${TENANT_ID}:fulfilment_model`)).toBeLessThan(at(`lock:release:${lock}`));
    expect(w.calls.bareTransaction).toBe(0);
  });

  it("both fields in one request: two rows and two audits in ONE transaction", async () => {
    const w = build({ fleet: true });
    const fingerprint = await fp(w);
    const out = await w.controller.update(
      { fulfilmentModel: "ship", counterSales: "on", fingerprint },
      admin,
    );
    expect(w.calls.txOpened).toBe(1);
    expect(w.row("fulfilment_model")!.mode).toBe("ship");
    expect(w.row("counter_sales")!.mode).toBe("on");
    expect(w.state.audits.map((a) => a.entityId).sort()).toEqual([
      "counter_sales",
      "fulfilment_model",
    ]);
    expect(out.counterSales).toEqual({ value: "on", effective: "optional" });
  });

  it("counter 'off' is stored as unset", async () => {
    const w = build({ fleet: true, rows: [{ featureKey: "counter_sales", mode: "on" }] });
    await w.controller.update({ counterSales: "off", fingerprint: await fp(w) }, admin);
    expect(w.row("counter_sales")!.mode).toBe("unset");
    expect(w.state.audits[0].meta).toMatchObject({ from: "on", to: "unset", mode: "unset" });
  });

  it("a request equal to what is stored is 200 changed:false with no tx, no write, no audit", async () => {
    const w = build({ fleet: true });
    const out = await w.controller.update(
      { fulfilmentModel: "unset", counterSales: "off", fingerprint: await fp(w) },
      admin,
    );
    expect(out.changed).toBe(false);
    expect(w.calls.txOpened).toBe(0);
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
  });

  it("only the field that differs is written", async () => {
    const w = build({ fleet: true, rows: [{ featureKey: "fulfilment_model", mode: "ship" }] });
    const before = w.row("fulfilment_model")!.updatedAt;
    await w.controller.update(
      { fulfilmentModel: "ship", counterSales: "on", fingerprint: await fp(w) },
      admin,
    );
    expect(w.prisma.tenantFeatureConfig.upsert).toHaveBeenCalledTimes(1);
    expect(w.row("fulfilment_model")!.updatedAt).toBe(before);
    expect(w.state.audits).toHaveLength(1);
  });

  it("a stale fingerprint is 409 FULFILMENT_SETTINGS_STALE carrying a FRESH GET body; nothing is written", async () => {
    const w = build({ fleet: true });
    const e = await bodyOf(
      w.controller.update({ fulfilmentModel: "ship", fingerprint: "0000000000000000" }, admin),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTINGS_STALE);
    const fresh = await w.controller.get(admin);
    // The body IS a fresh GET body, plus the coded envelope the client branches on.
    const { status: _s, statusCode: _sc, code: _c, message: _m, ...rest } = e;
    expect(rest).toEqual(fresh);
    expect(typeof e.message).toBe("string");
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
  });

  it("two concurrent changes from the same screen: one 200 and one 409 whose body shows the winner", async () => {
    const w = build({ fleet: true });
    const fingerprint = await fp(w);
    const [a, b] = await Promise.allSettled([
      w.controller.update({ fulfilmentModel: "ship", fingerprint }, admin),
      w.controller.update({ fulfilmentModel: "both", fingerprint }, admin),
    ]);
    const settled = [a, b];
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.getStatus()).toBe(409);
    const body = lost.reason.getResponse();
    expect(body.code).toBe(API_ERROR_CODES.FULFILMENT_SETTINGS_STALE);
    expect(body.fulfilmentModel.value).toBe(w.row("fulfilment_model")!.mode);
    expect(w.state.audits).toHaveLength(1);
  });

  it("own delivery without a fleet is the 409 NEEDS_FLEET and leaves no row and no audit", async () => {
    const w = build({ fleet: false });
    const e = await bodyOf(
      w.controller.update({ fulfilmentModel: "delivery", fingerprint: await fp(w) }, admin),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET);
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
  });

  it("a failed audit insert rolls the setting back", async () => {
    const w = build({ fleet: true, failAudit: true });
    await expect(
      w.controller.update({ fulfilmentModel: "ship", fingerprint: await fp(w) }, admin),
    ).rejects.toThrow("audit insert failed");
    expect(w.rowCount()).toBe(0);
    expect(w.state.audits).toEqual([]);
    expect(lockState.events).toContain("tx:rollback");
  });

  it("a failed write does not poison the next change (the lock was released)", async () => {
    const w = build({ fleet: true });
    w.prisma.auditLog.create.mockRejectedValueOnce(new Error("boom"));
    await expect(
      w.controller.update({ fulfilmentModel: "ship", fingerprint: await fp(w) }, admin),
    ).rejects.toThrow("boom");
    const out = await w.controller.update(
      { fulfilmentModel: "ship", fingerprint: await fp(w) },
      admin,
    );
    expect(out.changed).toBe(true);
  });

  it("impersonatedBy comes from the token only, never the body", async () => {
    const w = build({ fleet: true });
    await w.controller.update(
      { fulfilmentModel: "ship", fingerprint: await fp(w), impersonatedBy: "evil" } as never,
      user("TENANT_ADMIN", { impersonatedBy: "sa-9" }),
    );
    expect(w.state.audits[0].impersonatedBy).toBe("sa-9");
  });

  it("the tenant comes from the request context only: a body tenantId is ignored and another tenant's row is untouched", async () => {
    const w = build({
      fleet: true,
      rows: [{ tenantId: OTHER_TENANT_ID, featureKey: "fulfilment_model", mode: "delivery" }],
    });
    await w.controller.update(
      { fulfilmentModel: "ship", fingerprint: await fp(w), tenantId: OTHER_TENANT_ID } as never,
      admin,
    );
    expect(w.row("fulfilment_model", OTHER_TENANT_ID)!.mode).toBe("delivery");
    expect(w.row("fulfilment_model")!.mode).toBe("ship");
    expect(w.state.audits.every((a) => a.tenantId === TENANT_ID)).toBe(true);
  });

  it("refuses a token tenant that differs from the request tenant before taking the lock", async () => {
    const w = build({ fleet: true });
    const e = await bodyOf(
      w.controller.update(
        { fulfilmentModel: "ship", fingerprint: await fp(w) },
        user("TENANT_ADMIN", { tenantId: OTHER_TENANT_ID }),
      ),
    );
    expect(e.status).toBe(403);
    expect(lockState.calls).toEqual([]);
    expect(w.rowCount()).toBe(0);
  });

  it("never buys, grants or removes an add-on or an override", async () => {
    const w = build({ fleet: true });
    await w.controller.update(
      { fulfilmentModel: "ship", counterSales: "on", fingerprint: await fp(w) },
      admin,
    );
    expect(w.addonService.enableAddon).not.toHaveBeenCalled();
    expect(w.addonService.disableAddon).not.toHaveBeenCalled();
    expect(w.addonService.setAddon).not.toHaveBeenCalled();
    for (const m of ["grant", "deny", "set", "clear", "create"] as const) {
      expect(w.featureOverrides[m]).not.toHaveBeenCalled();
    }
  });

  it("a lock that times out is a retryable 409 CONCURRENT_UPDATE; an unavailable lock a 503", async () => {
    const w = build({ fleet: true });
    const fingerprint = await fp(w);
    lockState.failWith = new LockTimeoutError("fulfilment-settings", TENANT_ID, 10_000);
    const busy = await bodyOf(w.controller.update({ fulfilmentModel: "ship", fingerprint }, admin));
    expect(busy.status).toBe(409);
    expect(busy.code).toBe(API_ERROR_CODES.CONCURRENT_UPDATE);
    lockState.failWith = new LockUnavailableError(new Error("pool"));
    const down = await bodyOf(w.controller.update({ fulfilmentModel: "ship", fingerprint }, admin));
    expect(down.status).toBe(503);
    expect(w.rowCount()).toBe(0);
  });

  it("a pickup mode outside the pilot is a coded 400 and writes nothing", async () => {
    const w = build({ fleet: true });
    const e = await bodyOf(
      w.controller.update({ fulfilmentModel: "pickup_ship", fingerprint: await fp(w) }, admin),
    );
    expect(e.status).toBe(400);
    expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_SETTING_INVALID);
    expect(w.rowCount()).toBe(0);
  });

  it("a pickup mode for an allowlisted pilot is written", async () => {
    process.env.FULFILMENT_SELF_SERVE = "allowlist";
    process.env.FULFILMENT_SELF_SERVE_TENANTS = "qa-acme";
    const w = build({ fleet: true });
    const out = await w.controller.update(
      { fulfilmentModel: "pickup", fingerprint: await fp(w) },
      admin,
    );
    expect(w.row("fulfilment_model")!.mode).toBe("pickup");
    expect(out.counterSales.effective).toBe("always");
  });

  describe("FULFILMENT_CARRIER_IN_TRANSIT (M1 interim rule)", () => {
    const shipped = (over: Record<string, unknown> = {}) =>
      order({ fulfillPath: "SHIP", status: "OUT_FOR_DELIVERY", shippedAt: new Date(), ...over });
    const stored = (mode: string) => [{ featureKey: "fulfilment_model" as const, mode }];

    it("refuses a change that crosses the shipping set while a shipped carrier order is open", async () => {
      const w = build({
        fleet: true,
        rows: stored("ship"),
        orders: [
          shipped(),
          shipped(),
          shipped({ status: "DELIVERED" }),
          shipped({ status: "CANCELLED" }),
        ],
      });
      const e = await bodyOf(
        w.controller.update({ fulfilmentModel: "delivery", fingerprint: await fp(w) }, admin),
      );
      expect(e.status).toBe(409);
      expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT);
      expect(e.count).toBe(2);
      expect(w.row("fulfilment_model")!.mode).toBe("ship");
      expect(w.state.audits).toEqual([]);
    });

    it("the same rule applies when moving INTO the shipping set", async () => {
      const w = build({ fleet: true, rows: stored("delivery"), orders: [shipped()] });
      const e = await bodyOf(
        w.controller.update({ fulfilmentModel: "ship", fingerprint: await fp(w) }, admin),
      );
      expect(e.code).toBe(API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT);
    });

    it("allows a change that stays inside the shipping set (ship -> both)", async () => {
      const w = build({ fleet: true, rows: stored("ship"), orders: [shipped()] });
      const out = await w.controller.update(
        { fulfilmentModel: "both", fingerprint: await fp(w) },
        admin,
      );
      expect(out.changed).toBe(true);
    });

    it("allows a change that stays outside the shipping set (unset -> delivery)", async () => {
      const w = build({ fleet: true, orders: [shipped()] });
      const out = await w.controller.update(
        { fulfilmentModel: "delivery", fingerprint: await fp(w) },
        admin,
      );
      expect(out.changed).toBe(true);
    });

    it("does not count orders that have not shipped, are closed, are not carrier orders, or are another tenant's", async () => {
      const w = build({
        fleet: true,
        rows: stored("ship"),
        orders: [
          shipped({ shippedAt: null }),
          shipped({ status: "DELIVERED" }),
          shipped({ fulfillPath: "ROUTE" }),
          shipped({ tenantId: OTHER_TENANT_ID }),
        ],
      });
      const out = await w.controller.update(
        { fulfilmentModel: "delivery", fingerprint: await fp(w) },
        admin,
      );
      expect(out.changed).toBe(true);
    });

    it("a counter-only change never evaluates the rule", async () => {
      const w = build({ fleet: true, rows: stored("ship"), orders: [shipped()] });
      const out = await w.controller.update(
        { counterSales: "on", fingerprint: await fp(w) },
        admin,
      );
      expect(out.changed).toBe(true);
    });

    it("is evaluated inside the transaction, scoped to the tenant", async () => {
      const w = build({ fleet: true, rows: stored("ship"), orders: [shipped()] });
      const fingerprint = await fp(w);
      w.calls.count.length = 0;
      await bodyOf(w.controller.update({ fulfilmentModel: "delivery", fingerprint }, admin));
      expect(w.calls.txOpened).toBe(1);
      const carrier = w.calls.count.find((c) => c.where.shippedAt !== undefined)!;
      expect(carrier.where.tenantId).toBe(TENANT_ID);
      expect(carrier.where.fulfillPath).toBe("SHIP");
    });
  });
});

describe("logging", () => {
  it("does not spam: a read warns about nothing when the flag is a plain 'on'", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await build({ fleet: true }).controller.get(admin);
    expect(warn).not.toHaveBeenCalled();
  });
});
