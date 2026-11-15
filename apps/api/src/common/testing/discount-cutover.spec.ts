// SA-1153: the harness itself. The import is FIRST on purpose (it registers the @routeflow/pricing mock).
import {
  AFTER,
  BEFORE,
  CUTOVER,
  FIXTURE,
  expectFixtureDiscriminates,
  fixtureTotals,
  setDiscountCutover,
  underCutover,
  withDiscountCutover,
} from "./discount-cutover";
import { DISCOUNT_PRE_TAX_FROM } from "@routeflow/pricing";
import { discountModeOf, newDocumentDiscountMode } from "../discount-tax-mode";

describe("withDiscountCutover (SA-1153)", () => {
  describe("a describe that sets the cutover", () => {
    withDiscountCutover();

    it("reads CUTOVER, so a new document is PRE_TAX on the real clock and a BEFORE source stays LEGACY", () => {
      expect(DISCOUNT_PRE_TAX_FROM).toEqual(CUTOVER);
      expect(newDocumentDiscountMode()).toBe("PRE_TAX");
      expect(discountModeOf({ createdAt: BEFORE })).toBe("LEGACY_POST_TAX");
      expect(discountModeOf({ createdAt: AFTER })).toBe("PRE_TAX");
    });

    it("the swap this harness exists to catch is visible: a BEFORE source and 'now' disagree", () => {
      expect(discountModeOf({ createdAt: BEFORE })).not.toBe(newDocumentDiscountMode());
    });

    it("underCutover(null) is the dark run and puts the cutover back", async () => {
      const dark = await underCutover(null, () => [
        newDocumentDiscountMode(),
        discountModeOf({ createdAt: AFTER }),
      ]);
      expect(dark).toEqual(["LEGACY_POST_TAX", "LEGACY_POST_TAX"]);
      expect(DISCOUNT_PRE_TAX_FROM).toEqual(CUTOVER);
    });

    it("the fixture discriminates: the two modes tax it differently (assertion 1 of every row)", () => {
      expectFixtureDiscriminates();
      const pre = fixtureTotals("PRE_TAX");
      const legacy = fixtureTotals("LEGACY_POST_TAX");
      expect(pre.tax).toBeLessThan(legacy.tax);
      expect(FIXTURE.discount).toBeGreaterThan(0);
    });
  });

  describe("without the harness's beforeEach, dark answers LEGACY everywhere (why two rounds failed)", () => {
    it("is restored to null after each test of the describe above", () => {
      setDiscountCutover(null);
      expect(DISCOUNT_PRE_TAX_FROM).toBeNull();
      expect(newDocumentDiscountMode()).toBe("LEGACY_POST_TAX");
      expect(discountModeOf({ createdAt: AFTER })).toBe("LEGACY_POST_TAX");
    });
  });
});
