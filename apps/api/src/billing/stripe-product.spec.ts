import { fakeStripeProducts } from "../testing/fake-stripe-products";
import { PLAN_DISPLAY_NAMES, planDisplayName } from "@routeflow/pricing";
import {
  ensureAddonProduct,
  ensurePlanProduct,
  ensureStripeProduct,
  stripeProductId,
} from "./stripe-product";
import { PLAN_KEYS } from "./plan-catalog.constants";

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

const DASH = /[–—-]/;

describe("SA-1547 Q3: plan products are named by the plan key alone", () => {
  it("R16: every PLAN_KEY creates its product named planDisplayName, no dash, never the raw key", async () => {
    for (const key of PLAN_KEYS) {
      const f = fakeStripeProducts();
      const id = await ensurePlanProduct(f, key, "Some definition name");
      const name = f.table.get(id)!.name!;
      expect({ key, name }).toEqual({ key, name: planDisplayName(key) });
      expect(name).not.toMatch(DASH);
      expect(name).not.toContain("RouteFlow");
      if (key !== name.toUpperCase()) expect(name).not.toBe(key);
    }
    expect(Object.keys(PLAN_DISPLAY_NAMES).sort()).toEqual([...PLAN_KEYS].sort());
  });

  it("R15: a found product still named 'RouteFlow Essentials' is renamed to 'Essentials' once; a second ensure writes nothing", async () => {
    const f = fakeStripeProducts([
      { id: "rf_plan_core", active: true, name: "RouteFlow Essentials" },
    ]);
    await ensurePlanProduct(f, "CORE", "Core (definition)");
    expect(f.products.update).toHaveBeenCalledTimes(1);
    expect(f.products.update).toHaveBeenCalledWith("rf_plan_core", { name: "Essentials" });
    expect(f.table.get("rf_plan_core")!.name).toBe("Essentials");
    await ensurePlanProduct(f, "CORE", "Core (definition)");
    expect(f.products.update).toHaveBeenCalledTimes(1);
  });

  it("R15: two callers passing different definition names cannot flap the name (one update in all)", async () => {
    const f = fakeStripeProducts([
      { id: "rf_plan_growth", active: true, name: "RouteFlow Growth" },
    ]);
    await ensurePlanProduct(f, "GROWTH", "Growth");
    await ensurePlanProduct(f, "GROWTH", "Growth (2026 catalog)");
    await ensurePlanProduct(f, "GROWTH");
    expect(f.products.update).toHaveBeenCalledTimes(1);
    expect(f.table.get("rf_plan_growth")!.name).toBe("Growth");
  });

  it("R17: a rename writes the name only (no price, no subscription item); an inactive one is also reactivated in the same call", async () => {
    const f = fakeStripeProducts([{ id: "rf_plan_pro", active: false, name: "RouteFlow Pro" }]);
    await ensurePlanProduct(f, "ALL_IN");
    const g = fakeStripeProducts([{ id: "rf_plan_all_in", active: false, name: "RouteFlow Pro" }]);
    await ensurePlanProduct(g, "ALL_IN");
    expect(g.products.update).toHaveBeenCalledTimes(1);
    expect(g.products.update).toHaveBeenCalledWith("rf_plan_all_in", { active: true, name: "Pro" });
    for (const [, params] of g.products.update.mock.calls) {
      expect(Object.keys(params as object).sort()).toEqual(
        Object.keys(params as object)
          .filter((k) => k === "active" || k === "name")
          .sort(),
      );
    }
    expect(f.products.create).toHaveBeenCalledTimes(1); // a different id: created, nothing else touched
  });

  it("a key planDisplayName does not name is created with the definition name and never renamed", async () => {
    const f = fakeStripeProducts();
    const id = await ensurePlanProduct(f, "LEGACY_TEAM", "Growth (original)");
    expect(f.table.get(id)!.name).toBe("Growth (original)");
    await ensurePlanProduct(f, "LEGACY_TEAM", "Something else");
    expect(f.products.update).not.toHaveBeenCalled();
    expect(f.table.get(id)!.name).toBe("Growth (original)");
  });

  it("a key with no display name and no definition name is refused before Stripe (never the raw key)", async () => {
    const f = fakeStripeProducts();
    await expect(ensurePlanProduct(f, "LEGACY_TEAM")).rejects.toThrow(/no display name/);
    await expect(ensurePlanProduct(f, "LEGACY_TEAM", "  ")).rejects.toThrow(/no display name/);
    expect(f.products.retrieve).not.toHaveBeenCalled();
    expect(f.products.create).not.toHaveBeenCalled();
  });
});

describe("SA-1547 Q3: add-on products read '{name} add-on' (no dash), set on create only", () => {
  it.each(["SMS Pack", "Route Optimization", "Extra Users", "Cold-Chain Logs"])(
    "R16: %s is created as '<name> add-on' with no em or en dash",
    async (name) => {
      const f = fakeStripeProducts();
      const id = await ensureAddonProduct(f, "sku_x", name);
      expect(f.table.get(id)!.name).toBe(`${name} add-on`);
      expect(f.table.get(id)!.name).not.toMatch(/[–—]/);
      expect(f.table.get(id)!.name).not.toContain("RouteFlow");
    },
  );

  it("an existing add-on product keeps its name (two name sources, so no reconcile)", async () => {
    const f = fakeStripeProducts([
      { id: "rf_addon_sms_pack", active: true, name: "RouteFlow add-on — SMS Pack" },
    ]);
    await ensureAddonProduct(f, "sms_pack", "SMS Pack");
    expect(f.products.update).not.toHaveBeenCalled();
  });
});
