import { ServiceUnavailableException } from "@nestjs/common";
import { GUARDS_METADATA, INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { FeatureConfigService } from "./feature-config.service";
import { FulfilmentCapabilityService } from "./fulfilment-capability.service";
import { BuyerController } from "../buyer/buyer.controller";
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

  it("never reads counter_sales (it never changes the portal fields)", async () => {
    const { svc, getEffectiveMode } = makeService({ mode: "ship" });
    await svc.forBuyer("t1");
    expect(getEffectiveMode.mock.calls.map((c) => c[1])).toEqual(["fulfilment_model"]);
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

describe("GET /buyer/capabilities", () => {
  const handler = () => (BuyerController.prototype as any).getSellerCapabilities;

  it("exists, and is seller-scoped exactly like the other buyer reads", () => {
    expect(typeof handler()).toBe("function");
    expect(Reflect.getMetadata(GUARDS_METADATA, handler())).toEqual([BuyerSellerContextGuard]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler())).toEqual([BuyerTenantInterceptor]);
  });

  it("the body is EXACTLY { portalMethods, portalDefault, fleet } for the active seller", async () => {
    const { svc } = makeService({ mode: "ship" });
    const forBuyer = jest.spyOn(svc, "forBuyer");
    const controller = Object.create(BuyerController.prototype);
    (controller as any).fulfilmentCapability = svc;
    const body = await handler().call(controller, { tenantId: "tenant-ship", customerId: "c1" });
    expect(Object.keys(body).sort()).toEqual(BUYER_KEYS);
    for (const staffField of ["methods", "staffDefault", "staffOpensAs", "counter", "consistent"]) {
      expect(body).not.toHaveProperty(staffField);
    }
    expect(body).toEqual({ portalMethods: ["SHIP"], portalDefault: "SHIP", fleet: false });
    expect(forBuyer).toHaveBeenCalledWith("tenant-ship");
  });
});
