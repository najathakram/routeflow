import "reflect-metadata";
import { ExecutionContext, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { customerLinePrice, type CustomerLayerUnit } from "@routeflow/pricing";
import { decideTierOverride } from "../orders/staff-override";
import { customerPricing } from "../orders/units-prices-v2";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { buildCustomerPriceLayer } from "./customer-price-layer";
import { CustomerPriceLayerController } from "./customer-price-layer.controller";
import { CustomerUnitPricesService } from "./customer-unit-prices.service";

/**
 * S19b A-1 / A-1b / A-6 (SA-811a, SA-813): the price-layer endpoint, its serializer and the client's `customerLinePrice` are
 * ONE answer. The fixtures run through the server loader (a mocked tenant db), the endpoint, then `customerLinePrice`, and
 * are compared with `customerPricing().layer` and `decideTierOverride`'s baseline: if billing moves, this goes red.
 */
const noTiers = { priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null };
const PRODUCT = {
  id: "p1",
  name: "Cola",
  unit: "Box",
  packLabel: null,
  baseUnitLabel: null,
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "40.00",
  priceTier3: "39.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  orderUnitRef: "pack",
  packAuto: 0,
  isActive: true,
};
const CASE_UNIT = {
  id: "u-case",
  productId: "p1",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  sortOrder: 0,
  ...noTiers,
};

function harness(opts: {
  typed?: Array<[string, number]>;
  customerOrderUnit?: string;
  customer?: unknown;
  flag?: boolean;
}) {
  const hasFlag = jest.fn().mockResolvedValue(opts.flag ?? true);
  const db = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue("customer" in opts ? opts.customer : { id: "c1", pricingTier: 1 }),
    },
    customerUnitPrice: {
      findMany: jest.fn().mockResolvedValue(
        (opts.typed ?? []).map(([unitRef, price]) => ({
          productId: "p1",
          unitRef,
          price: String(price),
        })),
      ),
    },
    customerPrice: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.customerOrderUnit
            ? [{ productId: "p1", pricingTier: null, orderUnitRef: opts.customerOrderUnit }]
            : [],
        ),
    },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    productUnit: { findMany: jest.fn().mockResolvedValue([CASE_UNIT]) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = {
    prisma: { forTenant: () => db, getTenantId: () => "t1" },
    entitlements: { hasFlag, hasFlagStrict: hasFlag },
  } as never;
  return { db, svc, hasFlag };
}

/** What billing prices a line with, for the same fixtures (the S19 loader). */
async function billingLayer(h: ReturnType<typeof harness>, label: string | null, cpUnit?: string) {
  const pc = await customerPricing(
    h.svc,
    "c1",
    ["p1"],
    { pricingTier: 1 },
    [{ productId: "p1", pricingTier: null, orderUnitRef: cpUnit }],
    h.db as never,
  );
  return pc.layer(PRODUCT, label);
}

describe("A-1: the endpoint, the serializer and customerLinePrice are billing's answer (P-a..P-d)", () => {
  it("P-a: typed pack $33: the Case is $377.14 customer-shape, equal to billing's layer and the staff baseline", async () => {
    const h = harness({ typed: [["pack", 33]] });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    expect(res.complete).toBe(true);
    const layer = res.products.p1 as CustomerLayerUnit[];
    const line = customerLinePrice({ product: PRODUCT, tier: 1, layer, unitLabel: "Case" });
    expect(line).toMatchObject({
      price: 377.14,
      listPrice: 480,
      priceType: "SPECIAL",
      layered: true,
    });
    expect(layer.find((r) => r.label === "Case")).toMatchObject({ source: "customer-shape" });
    const billing = await billingLayer(h, "Case");
    expect(billing).toMatchObject({ price: line.price, listPrice: line.listPrice });
    // decideTierOverride (the staff paths) judges against the SAME baseline: echoing it is no override and the same type
    const staff = decideTierOverride(
      { ...PRODUCT, pricePerUnit: 42 },
      1,
      33,
      null,
      await billingLayer(h, null),
    );
    expect(staff).toMatchObject({ unitPrice: 33, priceType: "SPECIAL", overridden: false });
  });

  it("P-b: typed Case $450 on the customer's order unit: the pack is $39.38", async () => {
    const h = harness({ typed: [["u-case", 450]], customerOrderUnit: "u-case" });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    const line = customerLinePrice({
      product: PRODUCT,
      tier: 1,
      layer: res.products.p1,
      unitLabel: null,
    });
    expect(line).toMatchObject({ price: 39.38, listPrice: 42, layered: true });
    expect((await billingLayer(h, null, "u-case"))?.price).toBe(line.price);
  });

  it("P-c: typed pack $45 above the $42 list: aboveList, MANUAL, the same on the staff baseline", async () => {
    const h = harness({ typed: [["pack", 45]] });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    const layer = res.products.p1;
    expect(layer.find((r) => r.label === null)).toMatchObject({ price: 45, aboveList: true });
    expect(customerLinePrice({ product: PRODUCT, tier: 1, layer, unitLabel: null })).toMatchObject({
      price: 45,
      priceType: "MANUAL",
      layered: true,
    });
    expect(
      decideTierOverride(
        { ...PRODUCT, pricePerUnit: 42 },
        1,
        45,
        null,
        await billingLayer(h, null),
      ),
    ).toMatchObject({ priceType: "MANUAL", overridden: false });
  });

  it("P-d: no typed row: no layer rows, and customerLinePrice is master (getTierPrice tier 3, SPECIAL)", async () => {
    const h = harness({});
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    expect(res).toEqual({ customerId: "c1", complete: true, products: {} });
    expect(customerLinePrice({ product: PRODUCT, tier: 3, layer: res.products.p1 })).toMatchObject({
      price: 39,
      priceType: "SPECIAL",
      layered: false,
    });
  });
});

describe("A-1b (SA-813 M2): one label rule on the server and the client", () => {
  it("lowercase 'case' matches the Case row on BOTH sides", async () => {
    const h = harness({ typed: [["pack", 33]] });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    const client = customerLinePrice({
      product: PRODUCT,
      tier: 1,
      layer: res.products.p1,
      unitLabel: "case",
    });
    expect(client.price).toBe(377.14);
    expect((await billingLayer(h, "case"))?.price).toBe(377.14);
  });
  it("the base label matches the base row on both sides (Piece, derived: no ProductUnit row)", async () => {
    const h = harness({ typed: [["base", 1.5]] });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    const client = customerLinePrice({
      product: PRODUCT,
      tier: 1,
      layer: res.products.p1,
      unitLabel: "piece",
    });
    expect(client).toMatchObject({ price: 1.5, layered: true });
    expect((await billingLayer(h, "Piece"))?.price).toBe(1.5);
  });
  it("an unknown or renamed label has NO row on both sides", async () => {
    const h = harness({ typed: [["pack", 33]] });
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    expect(await billingLayer(h, "Carton Case")).toBeNull();
    expect(
      customerLinePrice({
        product: PRODUCT,
        tier: 1,
        layer: res.products.p1,
        unitLabel: "Carton Case",
      }),
    ).toMatchObject({ layered: false, price: 42 });
  });
});

describe("A-8 (SA-813 M1): no silent truncation at the typed-row cap", () => {
  it("more typed rows than the cap: complete false, and only the products inside the cap are answered", async () => {
    const h = harness({ typed: [["pack", 33]] });
    const rows = Array.from({ length: 5001 }, (_, i) => ({ productId: i === 0 ? "p1" : `x${i}` }));
    h.db.customerUnitPrice.findMany.mockResolvedValueOnce(rows);
    const res = await buildCustomerPriceLayer(h.svc, "c1");
    expect(res.complete).toBe(false);
    expect(res.products.p1).toBeDefined();
    expect(h.db.customerUnitPrice.findMany.mock.calls[0][0].take).toBe(5001);
  });
  it("exactly at the cap is complete", async () => {
    const h = harness({ typed: [["pack", 33]] });
    h.db.customerUnitPrice.findMany.mockResolvedValueOnce(
      Array.from({ length: 5000 }, () => ({ productId: "p1" })),
    );
    expect((await buildCustomerPriceLayer(h.svc, "c1")).complete).toBe(true);
  });
});

describe("A-6: the route is gated like K6 and tenant-scoped", () => {
  it("class-level JwtAuthGuard, RolesGuard, PlanFlagGuard + flag.units_prices_v2; one OPERATOR GET", () => {
    expect(Reflect.getMetadata("path", CustomerPriceLayerController)).toBe(
      "customers/:customerId/price-layer",
    );
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, CustomerPriceLayerController)).toBe(
      "flag.units_prices_v2",
    );
    const guards = (Reflect.getMetadata("__guards__", CustomerPriceLayerController) ??
      []) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]);
    const handler = CustomerPriceLayerController.prototype.layer as unknown as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata("method", handler)).toBe(0);
    expect(Object.getOwnPropertyNames(CustomerPriceLayerController.prototype).sort()).toEqual([
      "constructor",
      "layer",
    ]);
  });

  it("flag off: the REAL PlanFlagGuard on this controller answers 403 PLAN_GATE", async () => {
    const prev = process.env.PLAN_FLAG_ENFORCEMENT;
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    try {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({ planKey: "STARTER", flags: [] }),
      };
      const authority = { can: jest.fn().mockResolvedValue(false) };
      const guard = new PlanFlagGuard(
        new Reflector(),
        entitlements as never,
        {
          upgradeTargetForFlag: jest.fn().mockResolvedValue({
            planKey: "SCALE",
            planMonthlyPrice: "499.00",
            addonSku: null,
            addonMonthlyPrice: null,
          }),
        } as never,
        { get: jest.fn().mockResolvedValue(null) } as never,
        authority as never,
      );
      const ctx = {
        getHandler: () => CustomerPriceLayerController.prototype.layer,
        getClass: () => CustomerPriceLayerController,
        switchToHttp: () => ({ getRequest: () => ({ user: { tenantId: "t1" } }) }),
      } as unknown as ExecutionContext;
      const err = await guard.canActivate(ctx).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "PLAN_GATE" });
    } finally {
      if (prev === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = prev;
    }
  });

  it("a customer outside the tenant is a 404 before any price row is read", async () => {
    const h = harness({ customer: null });
    await expect(buildCustomerPriceLayer(h.svc, "other")).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.customerUnitPrice.findMany).not.toHaveBeenCalled();
    // every read carries the tenant
    expect(h.db.customer.findFirst.mock.calls[0][0].where).toEqual({ id: "other", tenantId: "t1" });
  });

  it("every price read carries the tenantId; the service delegates to the same function", async () => {
    const h = harness({ typed: [["pack", 33]] });
    await buildCustomerPriceLayer(h.svc, "c1");
    for (const m of [h.db.customerUnitPrice, h.db.customerPrice, h.db.product, h.db.productUnit]) {
      expect(m.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    }
    const svc = new CustomerUnitPricesService(
      { forTenant: () => h.db, getTenantId: () => "t1" } as never,
      { hasFlag: h.hasFlag, hasFlagStrict: h.hasFlag } as never,
    );
    expect((await svc.priceLayer("c1")).products.p1).toBeDefined();
  });
});
