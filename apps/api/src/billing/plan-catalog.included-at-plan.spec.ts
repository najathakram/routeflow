/**
 * B1102 — `AddonSku.includedAtPlan` is a free-text column. A misspelled plan key ranks -1 in
 * `isAddonIncludedAtPlan`, which reads as "bundled at no plan", so the add-on silently bills on
 * every plan. Guards: (1) every shipped catalog constant carries a legal key, (2) the validator is
 * proven able to fail (negative control), (3) the admin write path (`updateSku`) and `publish`
 * refuse an unknown key, (4) the inclusion helper's behaviour for a real key is pinned.
 */
import { BadRequestException } from "@nestjs/common";
import { V11_ADDON_SEEDS } from "../../prisma/plan-catalog-v11.definitions";
import { V12_ADDON_SEEDS, buildV12Rows } from "../../prisma/plan-catalog-v12.definitions";
import { V13_ADDON_SEEDS, buildV13Rows } from "../../prisma/plan-catalog-v13.definitions";
import {
  findInvalidIncludedAtPlan,
  isAddonIncludedAtPlan,
  isValidIncludedAtPlan,
} from "./plan-catalog.constants";
import { PlanCatalogService } from "./plan-catalog.service";

/** Fails naming the offending SKU and value, so a typo is found without a debugger. */
function assertAllIncludedAtPlanValid(
  label: string,
  skus: readonly { sku: string; includedAtPlan?: string | null }[],
): void {
  const bad = findInvalidIncludedAtPlan(skus);
  if (bad.length > 0) {
    throw new Error(
      `${label}: unknown includedAtPlan -> ` +
        bad.map((b) => `${b.sku}="${b.includedAtPlan}"`).join(", "),
    );
  }
}

type SkuLike = readonly { sku: string; includedAtPlan?: string | null }[];
const SHIPPED: Array<[string, SkuLike]> = [
  ["V11_ADDON_SEEDS", V11_ADDON_SEEDS],
  ["V12_ADDON_SEEDS", V12_ADDON_SEEDS],
  ["V13_ADDON_SEEDS", V13_ADDON_SEEDS],
  ["buildV12Rows().addonSkuRows", buildV12Rows(null).addonSkuRows],
  ["buildV13Rows().addonSkuRows", buildV13Rows(null).addonSkuRows],
];

describe("B1102 includedAtPlan guard — shipped catalog constants", () => {
  it.each(SHIPPED)("%s: every includedAtPlan is null or a real plan key", (label, skus) => {
    expect(skus.length).toBeGreaterThan(0);
    assertAllIncludedAtPlanValid(label, skus);
  });
});

describe("B1102 includedAtPlan guard — negative control", () => {
  const typo = [
    { sku: "FORECASTING", includedAtPlan: "SCAEL" },
    { sku: "MSRP", includedAtPlan: null },
    { sku: "REGULATED_ITEMS", includedAtPlan: "SCALE" },
  ];

  it("the validator flags a misspelled key and names the sku and value", () => {
    expect(findInvalidIncludedAtPlan(typo)).toEqual([
      { sku: "FORECASTING", includedAtPlan: "SCAEL" },
    ]);
    expect(() => assertAllIncludedAtPlanValid("fake", typo)).toThrow(/FORECASTING="SCAEL"/);
  });

  it("rejects wrong case; accepts the empty string (legacy), null, current keys and legacy aliases", () => {
    expect(isValidIncludedAtPlan("")).toBe(true); // legacy: "" = never bundled (SA ruling)
    expect(isValidIncludedAtPlan("scale")).toBe(false);
    expect(isValidIncludedAtPlan("__proto__")).toBe(false);
    expect(isValidIncludedAtPlan(null)).toBe(true);
    expect(isValidIncludedAtPlan(undefined)).toBe(true);
    expect(isValidIncludedAtPlan("SCALE")).toBe(true);
    expect(isValidIncludedAtPlan("BUSINESS")).toBe(true);
  });
});

describe("B1102 includedAtPlan guard — behavioural pin", () => {
  it("a real key bundles the add-on at and above that plan, not below", () => {
    const forecasting = V11_ADDON_SEEDS.find((s) => s.sku === "FORECASTING")!;
    expect(forecasting.includedAtPlan).toBe("SCALE");
    expect(isAddonIncludedAtPlan(forecasting.includedAtPlan, "SCALE")).toBe(true);
    expect(isAddonIncludedAtPlan(forecasting.includedAtPlan, "ENTERPRISE")).toBe(true);
    expect(isAddonIncludedAtPlan(forecasting.includedAtPlan, "GROWTH")).toBe(false);
  });

  it("documents the hazard: a misspelled key reads as included nowhere (hence the write guards)", () => {
    expect(isAddonIncludedAtPlan("SCAEL", "SCALE")).toBe(false);
  });
});

describe("B1102 includedAtPlan guard — admin write path", () => {
  it("updateSku refuses a misspelled key and writes nothing", async () => {
    const update = jest.fn();
    const prisma = {
      planVersion: { findUnique: jest.fn().mockResolvedValue({ status: "DRAFT" }) },
      addonSku: { update },
    } as any;
    const svc = new PlanCatalogService(prisma);
    const call = svc.updateSku("v8", "FORECASTING", { includedAtPlan: "SCAEL" });
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(/FORECASTING.*SCAEL/);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([["SCALE"], [null], ["BUSINESS"]])("updateSku accepts includedAtPlan=%s", async (v) => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      planVersion: { findUnique: jest.fn().mockResolvedValue({ status: "DRAFT" }) },
      addonSku: { update },
    } as any;
    await new PlanCatalogService(prisma).updateSku("v8", "FORECASTING", { includedAtPlan: v });
    expect(update.mock.calls[0][0].data.includedAtPlan).toBe(v);
  });

  it("publish refuses a draft carrying a misspelled includedAtPlan and publishes nothing", async () => {
    const $transaction = jest.fn();
    const prisma = {
      planVersion: {
        findUnique: jest.fn().mockResolvedValue({
          status: "DRAFT",
          definitions: [{ planKey: "STARTER" }],
          addonSkus: [
            { sku: "FORECASTING", includedAtPlan: "SCAEL" },
            { sku: "MSRP", includedAtPlan: null },
          ],
        }),
      },
      $transaction,
    } as any;
    const call = new PlanCatalogService(prisma).publish("v8", "admin-1");
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(/FORECASTING.*SCAEL/);
    expect($transaction).not.toHaveBeenCalled();
  });
});
