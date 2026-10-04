import { ServiceUnavailableException } from "@nestjs/common";
import { GUARDS_METADATA, INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { FeatureConfigService } from "./feature-config.service";
import { FulfilmentCapabilityService } from "./fulfilment-capability.service";
import { BuyerController } from "../buyer/buyer.controller";
import { BuyerSellerContextGuard } from "../buyer/guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "../buyer/buyer-tenant.interceptor";

/**
 * Business profiles 1B: the buyer portal reads its SELLER's fulfilment capability. The staff
 * answer (`GET /tenants/me/features`) needs a staff JWT, so the buyer gets a minimal,
 * seller-scoped `GET /buyer/capabilities` that returns the fulfilment capability and nothing else.
 */
function makeService(opts: {
  mode?: string;
  counterSales?: string;
  held?: string[];
  modeFails?: boolean;
  fleetFails?: boolean;
}) {
  const getEffectiveMode = jest.fn(async (_t: string, key: string) => {
    if (opts.modeFails) throw new Error("db down");
    if (key === "fulfilment_model") return opts.mode ?? "unset";
    if (key === "counter_sales") return opts.counterSales ?? "unset";
    return "unset";
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
  return { svc, getEffectiveMode, addons };
}

describe("FulfilmentCapabilityService.forTenant (the same derivation /tenants/me/features serves)", () => {
  it("a shipping-only seller without fleet modules: SHIP only, no fleet, consistent", async () => {
    const { svc } = makeService({ mode: "ship" });
    expect(await svc.forTenant("t1")).toEqual({
      methods: ["SHIP"],
      staffDefault: "SHIP",
      staffOpensAs: "order",
      portalMethods: ["SHIP"],
      portalDefault: "SHIP",
      counter: "off",
      fleet: false,
      consistent: true,
    });
  });

  it("fleet comes from the modules alone (order_delivery held → fleet true)", async () => {
    const { svc } = makeService({ mode: "both", held: ["order_delivery"] });
    const cap = await svc.forTenant("t1");
    expect(cap.fleet).toBe(true);
    expect(cap.portalMethods).toEqual(["ROUTE", "SHIP"]);
  });

  it("an unset seller is today: no portal choice", async () => {
    const { svc } = makeService({ held: ["recurring_routes"] });
    const cap = await svc.forTenant("t1");
    expect(cap.portalMethods).toEqual([]);
    expect(cap.portalDefault).toBeNull();
    expect(cap.fleet).toBe(true);
  });

  it("a failed mode read is unset; a failed fleet read is the 503 FEATURES_UNAVAILABLE", async () => {
    expect((await makeService({ modeFails: true }).svc.forTenant("t1")).portalDefault).toBeNull();
    const p = makeService({ mode: "ship", fleetFails: true }).svc.forTenant("t1");
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await p.catch((e: ServiceUnavailableException) =>
      expect(e.getResponse()).toMatchObject({ code: "FEATURES_UNAVAILABLE" }),
    );
  });
});

describe("FulfilmentCapabilityService.portal (what a buyer order reads)", () => {
  it("reads the mode only, never the fleet modules (an order never fails on a fleet read)", async () => {
    const { svc, addons } = makeService({ mode: "ship", fleetFails: true });
    expect(await svc.portal("t1")).toEqual({ portalMethods: ["SHIP"], portalDefault: "SHIP" });
    expect(addons.getActiveAddons).not.toHaveBeenCalled();
  });

  it("returns only the two portal fields", async () => {
    const { svc } = makeService({ mode: "both" });
    expect(Object.keys(await svc.portal("t1")).sort()).toEqual(["portalDefault", "portalMethods"]);
  });
});

describe("GET /buyer/capabilities", () => {
  const handler = () => (BuyerController.prototype as any).getSellerCapabilities;

  it("exists, and is seller-scoped exactly like the other buyer reads", () => {
    expect(typeof handler()).toBe("function");
    expect(Reflect.getMetadata(GUARDS_METADATA, handler())).toEqual([BuyerSellerContextGuard]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler())).toEqual([BuyerTenantInterceptor]);
  });

  it("returns ONLY the fulfilment capability of the buyer's active seller", async () => {
    const { svc } = makeService({ mode: "ship" });
    const forTenant = jest.spyOn(svc, "forTenant");
    const controller = Object.create(BuyerController.prototype);
    (controller as any).fulfilmentCapability = svc;
    const body = await handler().call(controller, { tenantId: "tenant-ship", customerId: "c1" });
    expect(Object.keys(body)).toEqual(["fulfilment"]);
    expect(body.fulfilment.portalMethods).toEqual(["SHIP"]);
    expect(body.fulfilment.fleet).toBe(false);
    expect(forTenant).toHaveBeenCalledWith("tenant-ship");
  });
});
