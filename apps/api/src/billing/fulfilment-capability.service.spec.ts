import { ServiceUnavailableException } from "@nestjs/common";
import { GUARDS_METADATA, INTERCEPTORS_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { FeatureConfigService } from "./feature-config.service";
import { FulfilmentCapabilityService } from "./fulfilment-capability.service";
import { deriveFulfilmentCapability } from "./fulfilment-capability";
import { FULFILMENT_MODE_VALUES } from "@routeflow/types";
import { BuyerCapabilitiesController } from "../buyer/buyer-capabilities.controller";
import { BuyerModule } from "../buyer/buyer.module";
import { BuyerJwtAuthGuard } from "../buyer/guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "../buyer/guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "../buyer/buyer-tenant.interceptor";

/**
 * Business profiles 1B: the buyer portal reads its SELLER's fulfilment facts. The staff answer
 * (`GET /tenants/me/features`) needs a staff JWT and carries staff fields, so the buyer gets a
 * seller-scoped `GET /buyer/capabilities` that returns EXACTLY { portalMethods, portalDefault,
 * fleet } — no `methods`, `staffDefault`, `staffOpensAs`, `counter` or `consistent`.
 */
const BUYER_KEYS = ["fleet", "portalDefault", "portalMethods"];

function makeService(opts: {
  mode?: string;
  held?: string[];
  modeFails?: boolean;
  fleetFails?: boolean;
}) {
  const getEffectiveMode = jest.fn(async (_t: string, key: string) => {
    if (opts.modeFails) throw new Error("db down");
    return key === "fulfilment_model" ? (opts.mode ?? "unset") : "on";
  });
  const addons = {
    getActiveAddons: jest.fn(async () => {
      if (opts.fleetFails) throw new Error("db down");
      return opts.held ?? [];
    }),
  };
  const overrides = { allActive: jest.fn().mockResolvedValue(new Map()) };
  const svc = new (FulfilmentCapabilityService as any)(
    { getEffectiveMode } as unknown as FeatureConfigService,
    addons,
    overrides,
  ) as FulfilmentCapabilityService;
  return { svc, getEffectiveMode };
}

describe("FulfilmentCapabilityService.forBuyer", () => {
  it("returns exactly the three buyer-safe keys", async () => {
    const { svc } = makeService({ mode: "both", held: ["order_delivery"] });
    expect(Object.keys(await svc.forBuyer("t1")).sort()).toEqual(BUYER_KEYS);
  });

  it("a shipping-only seller without fleet modules: SHIP only, no fleet", async () => {
    const { svc } = makeService({ mode: "ship" });
    expect(await svc.forBuyer("t1")).toEqual({
      portalMethods: ["SHIP"],
      portalDefault: "SHIP",
      fleet: false,
    });
  });

  it("fleet comes from the modules alone (order_delivery held → fleet true)", async () => {
    const { svc } = makeService({ mode: "both", held: ["order_delivery"] });
    expect(await svc.forBuyer("t1")).toEqual({
      portalMethods: ["ROUTE", "SHIP"],
      portalDefault: "ROUTE",
      fleet: true,
    });
  });

  it("an unset seller is today: no portal choice", async () => {
    const { svc } = makeService({ held: ["recurring_routes"] });
    expect(await svc.forBuyer("t1")).toEqual({
      portalMethods: [],
      portalDefault: null,
      fleet: true,
    });
  });

  it("counter_sales never changes the buyer answer: read through the shared readFulfilmentInputs, derived as unset", async () => {
    const { svc, getEffectiveMode } = makeService({ mode: "ship" });
    const base = await svc.forBuyer("t1");
    expect(getEffectiveMode).toHaveBeenCalledWith("t1", "fulfilment_model");
    // A failing counter_sales read (fulfilment_model still answers) leaves the buyer body unchanged.
    getEffectiveMode.mockImplementation(async (_t: string, key: string) => {
      if (key === "counter_sales") throw new Error("db down");
      return "ship";
    });
    expect(await svc.forBuyer("t1")).toEqual(base);
  });

  it("a failed mode read is unset; a failed fleet read is the 503 FEATURES_UNAVAILABLE", async () => {
    expect((await makeService({ modeFails: true }).svc.forBuyer("t1")).portalDefault).toBeNull();
    const p = makeService({ mode: "ship", fleetFails: true }).svc.forBuyer("t1");
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await p.catch((e: ServiceUnavailableException) =>
      expect(e.getResponse()).toMatchObject({ code: "FEATURES_UNAVAILABLE" }),
    );
  });
});

describe("forBuyer goes through the ONE derivation (a stored mode never reaches a buyer raw)", () => {
  // Every mode the registry stores, plus a stored value the derivation does not know.
  it.each([...FULFILMENT_MODE_VALUES, "drone"])("stored mode %s", async (mode) => {
    for (const held of [[], ["order_delivery"]]) {
      const fleet = held.length > 0;
      const body = await makeService({ mode, held }).svc.forBuyer("t1");
      const derived = deriveFulfilmentCapability({ mode, counterSales: "unset", fleet });
      expect(body).toEqual({
        portalMethods: derived.portalMethods,
        portalDefault: derived.portalDefault,
        fleet,
      });
      expect(Object.keys(body).sort()).toEqual(BUYER_KEYS);
      expect(JSON.stringify(body)).not.toContain(`"${mode}"`);
    }
  });

  it("an unknown stored mode reaches the buyer as unset (no portal choice)", async () => {
    const body = await makeService({ mode: "drone" }).svc.forBuyer("t1");
    expect(body).toEqual({ portalMethods: [], portalDefault: null, fleet: false });
  });
});

describe("GET /buyer/capabilities", () => {
  const handler = () => (BuyerCapabilitiesController.prototype as any).getSellerCapabilities;

  it("exists, and is seller-scoped exactly like the other buyer reads", () => {
    expect(typeof handler()).toBe("function");
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BuyerModule)).toContain(
      BuyerCapabilitiesController,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, BuyerCapabilitiesController)).toEqual([
      BuyerJwtAuthGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler())).toEqual([BuyerSellerContextGuard]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler())).toEqual([BuyerTenantInterceptor]);
  });

  it("the body is EXACTLY { portalMethods, portalDefault, fleet, acceptingOrders } for the active seller", async () => {
    const { svc } = makeService({ mode: "ship" });
    const forBuyer = jest.spyOn(svc, "forBuyer");
    const controller = new BuyerCapabilitiesController(svc);
    const body = await handler().call(controller, { tenantId: "tenant-ship", customerId: "c1" });
    expect(Object.keys(body).sort()).toEqual([...BUYER_KEYS, "acceptingOrders"].sort());
    for (const staffField of ["methods", "staffDefault", "staffOpensAs", "counter", "consistent"]) {
      expect(body).not.toHaveProperty(staffField);
    }
    expect(body).toEqual({
      portalMethods: ["SHIP"],
      portalDefault: "SHIP",
      fleet: false,
      acceptingOrders: true,
    });
    expect(forBuyer).toHaveBeenCalledWith("tenant-ship");
  });

  // SA-733r6 (B4): a read-only (paused) seller says only "not taking online orders" - one boolean, no reason,
  // nothing about billing or plans reaches a buyer.
  // A3: acceptingOrders follows SELLER_READ_ONLY_BUYER_GATE - false only while the gate is ENFORCED (a dark gate
  // still takes the order, so the UI must not claim otherwise). The gate matrix itself lives in
  // buyer-capabilities.authz.spec.ts; this pins the no-reason body for the enforced case.
  it("acceptingOrders is false for a READ_ONLY seller when the gate is enforced, and the body names no billing reason", async () => {
    const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
    process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
    try {
      const { svc } = makeService({ mode: "ship" });
      const controller = new BuyerCapabilitiesController(svc);
      const body = await handler().call(controller, {
        tenantId: "tenant-ship",
        customerId: "c1",
        sellerStatus: "READ_ONLY",
      });
      expect(body.acceptingOrders).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/payment|billing|subscri|overdue|plan/i);
    } finally {
      if (saved === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
      else process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
    }
  });

  it("acceptingOrders stays true for a READ_ONLY seller while the gate is dark (the default)", async () => {
    const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
    delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    try {
      const { svc } = makeService({ mode: "ship" });
      const body = await handler().call(new BuyerCapabilitiesController(svc), {
        tenantId: "tenant-ship",
        customerId: "c1",
        sellerStatus: "READ_ONLY",
      });
      expect(body.acceptingOrders).toBe(true);
    } finally {
      if (saved !== undefined) process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
    }
  });

  it("acceptingOrders is true for an ACTIVE or TRIAL seller", async () => {
    const { svc } = makeService({ mode: "ship" });
    const controller = new BuyerCapabilitiesController(svc);
    for (const sellerStatus of ["ACTIVE", "TRIAL"]) {
      const body = await handler().call(controller, {
        tenantId: "t",
        customerId: "c",
        sellerStatus,
      });
      expect(body.acceptingOrders).toBe(true);
    }
  });
});
