import { NotFoundException } from "@nestjs/common";
import { ProductCustomerPricesService } from "./product-customer-prices.service";

/**
 * GET products/:productId/customer-prices (units v2): the customers holding typed prices on one product, in the shape
 * the planners take. Prisma and the grid read model are mocked at the module boundary.
 */

const PRODUCT_ID = "prod-1";

interface Row {
  id: string;
  businessName: string;
  displayName: string | null;
  pricingTier: number;
  prices: { pricingTier: number | null; orderUnitRef: string | null }[];
  unitPrices: { unitRef: string; price: unknown }[];
}
const customer = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  businessName: `${id} Market LLC`,
  displayName: null,
  pricingTier: 1,
  prices: [],
  unitPrices: [{ unitRef: "pack", price: "12.00" }],
  ...over,
});

function build(rows: Row[], units: { id: string; factorToBase: number; label: string }[] = []) {
  const customerFindMany = jest.fn(async (_args: any) => rows);
  const db = { customer: { findMany: customerFindMany } };
  const forTenant = jest.fn(() => db);
  const read = jest.fn(async (_db: unknown, productId: string) => {
    if (productId !== PRODUCT_ID) throw new NotFoundException("Product not found");
    return { revision: 7, units };
  });
  const service = new ProductCustomerPricesService({ forTenant } as never, { read } as never);
  return { service, customerFindMany, forTenant, read, db };
}

describe("ProductCustomerPricesService", () => {
  it("answers the contract shape: the product's grid revision and one DTO per customer", async () => {
    const { service } = build([
      customer("c1", {
        displayName: "Northside",
        pricingTier: 2,
        unitPrices: [
          { unitRef: "pack", price: "13.5" },
          { unitRef: "base", price: "0.5" },
        ],
      }),
    ]);
    await expect(service.get(PRODUCT_ID)).resolves.toEqual({
      productId: PRODUCT_ID,
      revision: 7,
      customers: [
        {
          customerId: "c1",
          name: "Northside",
          tier: 2,
          orderUnit: null,
          set: { pack: 13.5, base: 0.5 },
        },
      ],
      truncated: false,
    });
  });

  it("names the customer by display name, else business name", async () => {
    const { service } = build([
      customer("c1", { displayName: "  " }),
      customer("c2", { displayName: "Eastside" }),
    ]);
    const r = await service.get(PRODUCT_ID);
    expect(r.customers.map((c) => c.name)).toEqual(["c1 Market LLC", "Eastside"]);
  });

  it("tier is customerTierFor(the customer-product tier, the customer's tier)", async () => {
    const { service } = build([
      customer("own", { pricingTier: 2, prices: [{ pricingTier: 4, orderUnitRef: null }] }),
      customer("inherits", { pricingTier: 3, prices: [{ pricingTier: null, orderUnitRef: null }] }),
      customer("none", { pricingTier: 2, prices: [] }),
      customer("junk", { pricingTier: 9, prices: [{ pricingTier: 0, orderUnitRef: null }] }),
    ]);
    const r = await service.get(PRODUCT_ID);
    expect(r.customers.map((c) => [c.customerId, c.tier])).toEqual([
      ["own", 4],
      ["inherits", 3],
      ["none", 2],
      ["junk", 1],
    ]);
  });

  it("orderUnit is the customer's own order unit for this product, or null", async () => {
    const { service } = build([
      customer("set", { prices: [{ pricingTier: null, orderUnitRef: "pack" }] }),
      customer("tier-only", { prices: [{ pricingTier: 3, orderUnitRef: null }] }),
      customer("no-row", { prices: [] }),
    ]);
    const r = await service.get(PRODUCT_ID);
    expect(r.customers.map((c) => [c.customerId, c.orderUnit])).toEqual([
      ["set", "pack"],
      ["tier-only", null],
      ["no-row", null],
    ]);
  });

  it('stored refs are read as levels: a legacy row on the factor-1 unit\'s id is the "base" cell', async () => {
    const { service } = build(
      [
        customer("c1", {
          prices: [{ pricingTier: null, orderUnitRef: "u-piece" }],
          unitPrices: [
            { unitRef: "u-piece", price: "0.50" },
            { unitRef: "u-case", price: "30" },
          ],
        }),
      ],
      [
        { id: "u-piece", factorToBase: 1, label: "Piece" },
        { id: "u-case", factorToBase: 72, label: "Case" },
      ],
    );
    const [c] = (await service.get(PRODUCT_ID)).customers;
    expect(c.orderUnit).toBe("base");
    expect(c.set).toEqual({ base: 0.5, "u-case": 30 });
  });

  it("a legacy cell and its level cell collapse to one key: the exact level row wins, in either order", async () => {
    const units = [{ id: "u-piece", factorToBase: 1, label: "Piece" }];
    const legacy = { unitRef: "u-piece", price: "0.40" };
    const exact = { unitRef: "base", price: "0.50" };
    for (const unitPrices of [
      [legacy, exact],
      [exact, legacy],
    ]) {
      const { service } = build([customer("c1", { unitPrices })], units);
      expect((await service.get(PRODUCT_ID)).customers[0].set).toEqual({ base: 0.5 });
    }
  });

  it("rounds every money value to cents", async () => {
    const { service } = build([
      customer("c1", { unitPrices: [{ unitRef: "pack", price: "12.345" }] }),
    ]);
    expect((await service.get(PRODUCT_ID)).customers[0].set).toEqual({ pack: 12.35 });
  });

  it("an empty list is customers: [] and not truncated", async () => {
    const { service } = build([]);
    await expect(service.get(PRODUCT_ID)).resolves.toMatchObject({
      customers: [],
      truncated: false,
    });
  });

  it("caps at 500 customers, newest first, and says truncated when more exist", async () => {
    const many = Array.from({ length: 501 }, (_, i) => customer(`c${i}`));
    const { service, customerFindMany } = build(many);
    const r = await service.get(PRODUCT_ID);
    expect(r.customers).toHaveLength(500);
    expect(r.customers[0].customerId).toBe("c0");
    expect(r.customers[499].customerId).toBe("c499");
    expect(r.truncated).toBe(true);
    // one read, one row past the cap to know there is more, newest first
    expect(customerFindMany).toHaveBeenCalledTimes(1);
    expect(customerFindMany.mock.calls[0][0]).toMatchObject({
      take: 501,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  });

  it("exactly 500 customers is not truncated", async () => {
    const { service } = build(Array.from({ length: 500 }, (_, i) => customer(`c${i}`)));
    const r = await service.get(PRODUCT_ID);
    expect(r.customers).toHaveLength(500);
    expect(r.truncated).toBe(false);
  });

  it("asks for live customers with a typed price on THIS product, and reads only this product's rows (no N+1)", async () => {
    const { service, customerFindMany } = build([customer("c1")]);
    await service.get(PRODUCT_ID);
    expect(customerFindMany).toHaveBeenCalledTimes(1);
    const args = customerFindMany.mock.calls[0][0];
    expect(args.where).toEqual({
      deletedAt: null,
      unitPrices: { some: { productId: PRODUCT_ID } },
    });
    expect(args.select.unitPrices.where).toEqual({ productId: PRODUCT_ID });
    expect(args.select.prices.where).toEqual({ productId: PRODUCT_ID });
  });

  it("an unknown product (or another tenant's) is 404 and no customer is read", async () => {
    const { service, customerFindMany } = build([customer("c1")]);
    await expect(service.get("nope")).rejects.toBeInstanceOf(NotFoundException);
    expect(customerFindMany).not.toHaveBeenCalled();
  });

  it("everything is read through the tenant client, and the product read uses the same client", async () => {
    const { service, forTenant, read, db } = build([customer("c1")]);
    await service.get(PRODUCT_ID);
    expect(forTenant).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(db, PRODUCT_ID);
  });
});
