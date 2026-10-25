import { fakeStripeProducts } from "../testing/fake-stripe-products";
import { ensureStripeProduct, stripeProductId } from "./stripe-product";

describe("ensureStripeProduct (W-810 / SA-931)", () => {
  it("derives deterministic ids from the plan code and the add-on SKU", () => {
    expect(stripeProductId("plan", "STARTER")).toBe("rf_plan_starter");
    expect(stripeProductId("addon", "Route-Opt")).toBe("rf_addon_route-opt");
    expect(() => stripeProductId("plan", "  ")).toThrow();
  });

  it("creates the active product with the deterministic id when none exists", async () => {
    const f = fakeStripeProducts();
    const id = await ensureStripeProduct(f, "plan", "GROWTH", { name: "RouteFlow Growth" });
    expect(id).toBe("rf_plan_growth");
    expect(f.table.get(id)).toMatchObject({ active: true, name: "RouteFlow Growth" });
  });

  it("reuses an existing active product without writing", async () => {
    const f = fakeStripeProducts([
      { id: "rf_plan_growth", active: true, name: "RouteFlow Growth" },
    ]);
    await ensureStripeProduct(f, "plan", "GROWTH", { name: "RouteFlow Growth" });
    expect(f.products.create).not.toHaveBeenCalled();
    expect(f.products.update).not.toHaveBeenCalled();
  });

  it("reactivates an inactive product instead of creating a second one", async () => {
    const f = fakeStripeProducts([
      { id: "rf_plan_growth", active: false, name: "RouteFlow Growth" },
    ]);
    await ensureStripeProduct(f, "plan", "GROWTH", { name: "RouteFlow Growth" });
    expect(f.table.get("rf_plan_growth")?.active).toBe(true);
    expect(f.products.create).not.toHaveBeenCalled();
  });

  it("two enables of one SKU make ONE product, and the SKU rides its metadata", async () => {
    const f = fakeStripeProducts();
    const meta = { addonSku: "ROUTE_OPT" };
    const a = await ensureStripeProduct(f, "addon", "ROUTE_OPT", {
      name: "Route optimizer",
      metadata: meta,
    });
    const b = await ensureStripeProduct(f, "addon", "ROUTE_OPT", {
      name: "Route optimizer",
      metadata: meta,
    });
    expect(a).toBe(b);
    expect(f.table.size).toBe(1);
    expect(f.table.get(a)?.metadata).toEqual(meta);
  });

  it("recovers when another replica creates the product between retrieve and create", async () => {
    const f = fakeStripeProducts();
    const real = f.products.create.getMockImplementation()!;
    f.products.create.mockImplementationOnce(async (p: any) => {
      await real(p); // the other replica wins
      return real(p); // ours then fails with resource_already_exists
    });
    await expect(
      ensureStripeProduct(f, "plan", "GROWTH", { name: "RouteFlow Growth" }),
    ).resolves.toBe("rf_plan_growth");
  });

  it("surfaces any other Stripe failure so the caller can map it", async () => {
    const f = fakeStripeProducts();
    f.products.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    await expect(
      ensureStripeProduct(f, "plan", "GROWTH", { name: "RouteFlow Growth" }),
    ).rejects.toThrow("boom");
  });
});
