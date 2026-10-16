import {
  UNITS_PRICES_V2_FLAG,
  UnitsPricesV2FlagCache,
  mayInventSku,
  newProductTierFallback,
  variantTierValue,
} from "./new-product-tiers";

describe("new-product-tiers (S4 data rules under flag.units_prices_v2)", () => {
  it("pins the flag key", () => {
    expect(UNITS_PRICES_V2_FLAG).toBe("flag.units_prices_v2");
  });

  describe("mayInventSku", () => {
    it("flag on: no SKU is invented", () => expect(mayInventSku(true)).toBe(false));
    it("flag off: master behaviour, a SKU is invented", () =>
      expect(mayInventSku(false)).toBe(true));
  });

  describe("newProductTierFallback", () => {
    it("flag on: a tier nobody priced is 0, never the Retail price", () =>
      expect(newProductTierFallback(true, "12.50")).toBe("0"));
    it("flag off: master copies the Retail price", () =>
      expect(newProductTierFallback(false, "12.50")).toBe("12.50"));
  });

  describe("variantTierValue", () => {
    it("flag on, plain price only: tier column is 0", () =>
      expect(variantTierValue(true, undefined, "2.50")).toBe("0"));
    it("flag on, a family price record supplies the column: copied as today", () =>
      expect(variantTierValue(true, "1.75", "2.50")).toBe("1.75"));
    it("flag off, plain price only: master copies the plain price", () =>
      expect(variantTierValue(false, undefined, "2.50")).toBe("2.50"));
    it("flag off, family record: copied", () =>
      expect(variantTierValue(false, "1.75", "2.50")).toBe("1.75"));
  });

  describe("UnitsPricesV2FlagCache", () => {
    const entitlements = (impl: (t: string, k: string) => Promise<boolean>) => ({
      hasFlag: jest.fn(impl),
    });

    it("asks for the flag key and answers true when granted", async () => {
      const ent = entitlements(async (_t, k) => k === UNITS_PRICES_V2_FLAG);
      await expect(new UnitsPricesV2FlagCache().isOn(ent, "t1")).resolves.toBe(true);
      expect(ent.hasFlag).toHaveBeenCalledWith("t1", UNITS_PRICES_V2_FLAG);
    });

    it("caches 30 s per tenant: a second read inside the window does not call hasFlag", async () => {
      let now = 1_000;
      const cache = new UnitsPricesV2FlagCache(() => now);
      const ent = entitlements(async () => true);
      await cache.isOn(ent, "t1");
      now += 29_999;
      await cache.isOn(ent, "t1");
      expect(ent.hasFlag).toHaveBeenCalledTimes(1);
      await cache.isOn(ent, "t2"); // another tenant is its own entry
      expect(ent.hasFlag).toHaveBeenCalledTimes(2);
    });

    it("re-reads after 30 s, so a flip takes effect", async () => {
      let now = 1_000;
      let granted = false;
      const cache = new UnitsPricesV2FlagCache(() => now);
      const ent = entitlements(async () => granted);
      await expect(cache.isOn(ent, "t1")).resolves.toBe(false);
      granted = true;
      now += 30_000;
      await expect(cache.isOn(ent, "t1")).resolves.toBe(true);
      expect(ent.hasFlag).toHaveBeenCalledTimes(2);
    });

    it("fails closed to master behaviour: no entitlements, no tenant, or a throwing read is off, and a failure is not cached", async () => {
      const cache = new UnitsPricesV2FlagCache();
      await expect(cache.isOn(undefined, "t1")).resolves.toBe(false);
      await expect(
        cache.isOn(
          entitlements(async () => true),
          null,
        ),
      ).resolves.toBe(false);
      const flaky = entitlements(async () => {
        throw new Error("down");
      });
      await expect(cache.isOn(flaky, "t1")).resolves.toBe(false);
      const healthy = entitlements(async () => true);
      await expect(cache.isOn(healthy, "t1")).resolves.toBe(true);
    });
  });
});
