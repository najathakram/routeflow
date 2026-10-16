import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CustomerUnitPricesController } from "./customer-unit-prices.controller";
import { CustomerUnitPricesService } from "./customer-unit-prices.service";

/**
 * K6 (S20-read): GET /customers/:customerId/unit-prices. Prisma is mocked at the module boundary; the pricing math is the
 * real @routeflow/pricing resolver, so a price here is whatever the order screen would charge.
 */

const CUSTOMER_ID = "cust-1";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

const product = (over: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  name: "Cola",
  unit: "Case",
  baseUnitLabel: null,
  packLabel: null,
  unitsPerBox: 24,
  pricePerUnit: "24.00",
  priceTier2: "0.00",
  priceTier3: "0.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  sku: "SKU-1",
  barcode: null,
  unitSku: null,
  priceRevision: 3,
  ...over,
});

function build(
  data: {
    customer?: { id: string; businessName: string; pricingTier: number } | null;
    typed?: Array<{ productId: string; unitRef: string; price: string }>;
    cp?: Array<{ productId: string; pricingTier: number | null; orderUnitRef: string | null }>;
    products?: Array<ReturnType<typeof product>>;
    units?: Array<Record<string, unknown>>;
  } = {},
) {
  const db = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(
        "customer" in data
          ? data.customer
          : { id: CUSTOMER_ID, businessName: "Acme Foods", pricingTier: 1 },
      ),
    },
    customerUnitPrice: { findMany: jest.fn().mockResolvedValue(data.typed ?? []) },
    customerPrice: { findMany: jest.fn().mockResolvedValue(data.cp ?? []) },
    product: { findMany: jest.fn().mockResolvedValue(data.products ?? [product()]) },
    productUnit: { findMany: jest.fn().mockResolvedValue(data.units ?? []) },
  };
  const prisma = { forTenant: () => db };
  return Test.createTestingModule({
    controllers: [CustomerUnitPricesController],
    providers: [CustomerUnitPricesService, { provide: PrismaService, useValue: prisma }],
  })
    .overrideGuard(require("../auth/guards/jwt-auth.guard").JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(require("../auth/guards/roles.guard").RolesGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(require("../billing/plan-flag.guard").PlanFlagGuard)
    .useValue({ canActivate: () => true })
    .compile()
    .then((m) => ({ svc: m.get(CustomerUnitPricesService), db }));
}

describe("CustomerUnitPricesController (units v2, K6)", () => {
  it("mounts at customers/:customerId/unit-prices behind the units_prices_v2 flag", () => {
    expect(Reflect.getMetadata("path", CustomerUnitPricesController)).toBe(
      "customers/:customerId/unit-prices",
    );
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, CustomerUnitPricesController)).toBe(
      "flag.units_prices_v2",
    );
    const guards = (Reflect.getMetadata("__guards__", CustomerUnitPricesController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]);
  });

  it("is an operator read: one GET, no write verb", () => {
    const handler = CustomerUnitPricesController.prototype.list as unknown as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata("method", handler)).toBe(0); // RequestMethod.GET
    const names = Object.getOwnPropertyNames(CustomerUnitPricesController.prototype);
    expect(names.sort()).toEqual(["constructor", "list"]);
  });
});

describe("CustomerUnitPricesService.get", () => {
  it("refuses a customer outside the tenant (404) before reading any price row", async () => {
    const { svc, db } = await build({ customer: null });
    await expect(svc.get("other-tenant-customer")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.customerUnitPrice.findMany).not.toHaveBeenCalled();
    expect(db.customerPrice.findMany).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty list for a customer with no specific prices", async () => {
    const { svc, db } = await build();
    const res = await svc.get(CUSTOMER_ID);
    expect(res).toEqual(
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        customerName: "Acme Foods",
        tier: 1,
        products: [],
        total: 0,
        page: 1,
      }),
    );
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("a typed pack price is source customer; the list price and the tier price ride along", async () => {
    const { svc } = await build({
      typed: [{ productId: PRODUCT_ID, unitRef: "pack", price: "20.00" }],
    });
    const res = await svc.get(CUSTOMER_ID);
    expect(res.total).toBe(1);
    const p = res.products[0];
    expect(p).toEqual(
      expect.objectContaining({ productId: PRODUCT_ID, productName: "Cola", tier: 1, revision: 3 }),
    );
    const pack = p.rows.find((r) => r.ref === "pack")!;
    expect(pack).toEqual(
      expect.objectContaining({ price: 20, listPrice: 24, tierPrice: 24, source: "customer" }),
    );
    // No own order unit: they order in their tier's anchor, here the pack ("Same as your business setting").
    expect(p.orderUnit).toBeNull();
    expect(p.orderUnitLabel).toBe("Case");
    // The piece keeps the shape of the customer's price (their typed pack price), not the list's.
    const base = p.rows.find((r) => r.ref === "base")!;
    expect(base.source).toBe("customer-shape");
    expect(base.price).toBeCloseTo(20 / 24, 2);
    expect(base.listPrice).toBe(1);
  });

  it("a customer-product tier wins over the customer's tier and reads that tier's column", async () => {
    const { svc } = await build({
      customer: { id: CUSTOMER_ID, businessName: "Acme Foods", pricingTier: 2 },
      cp: [{ productId: PRODUCT_ID, pricingTier: 3, orderUnitRef: "base" }],
      products: [product({ priceTier2: "22.00", priceTier3: "21.00" })],
    });
    const res = await svc.get(CUSTOMER_ID);
    expect(res.tier).toBe(2);
    const p = res.products[0];
    expect(p.tier).toBe(3);
    expect(p.orderUnit).toBe("base");
    expect(p.orderUnitLabel).toBe("Piece");
    const pack = p.rows.find((r) => r.ref === "pack")!;
    expect(pack).toEqual(
      expect.objectContaining({ price: 21, listPrice: 24, tierPrice: 21, source: "tier" }),
    );
  });

  it("?productId narrows to that product and only reads that customer's rows for it", async () => {
    const { svc, db } = await build();
    await svc.get(CUSTOMER_ID, { productId: PRODUCT_ID });
    expect(db.customerUnitPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: CUSTOMER_ID, productId: PRODUCT_ID } }),
    );
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [PRODUCT_ID] } } }),
    );
  });

  it("?productId for a product outside the tenant is a 404", async () => {
    const { svc } = await build({ products: [] });
    await expect(svc.get(CUSTOMER_ID, { productId: PRODUCT_ID })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("pages the products and caps the page size", async () => {
    const { svc, db } = await build({
      typed: [{ productId: PRODUCT_ID, unitRef: "pack", price: "20.00" }],
    });
    const res = await svc.get(CUSTOMER_ID, { page: 3, limit: 5000 });
    expect(res.limit).toBe(100);
    expect(res.page).toBe(3);
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 200, take: 100 }),
    );
  });

  it("only ever reads; the mocked db has no write method to call", async () => {
    const { db } = await build();
    for (const model of Object.values(db)) {
      expect(Object.keys(model).filter((k) => /create|update|delete|upsert/.test(k))).toEqual([]);
    }
  });
});
