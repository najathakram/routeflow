/**
 * SA-1193 A1-2 (B1377): a skipped column's `label` is the name the billing page shows for what it needs: the catalog name
 * of its SKU in the tenant's catalog version, the same lookup `GET /billing/subscription` makes
 * (`SubscriptionService.getSubscription`: entitlements.resolve -> catalog.getVersionForTenant(planVersionId) -> addonSkus).
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  IMPORT_REQUIREMENT_SKU,
  ImportRequirementLabelService,
  requirementLabels,
} from "./import-requirement-labels";
import { ADDON_SKUS } from "../billing/plan-catalog.constants";
import { V11_ADDON_SEEDS } from "../../prisma/plan-catalog-v11.definitions";

const TENANT = "tenant-acme";

function build(tenantSkus: { sku: string; name: string }[], publishedSkus = V11_ADDON_SEEDS) {
  const prisma = { getTenantId: jest.fn(() => TENANT) };
  const entitlements = { resolve: jest.fn().mockResolvedValue({ planVersionId: "pv-7" }) };
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({ addonSkus: tenantSkus }),
    getPublishedCatalog: jest.fn().mockResolvedValue({ addonSkus: publishedSkus }),
  };
  const svc = new ImportRequirementLabelService(prisma as any, entitlements as any, catalog as any);
  return { svc, entitlements, catalog };
}

describe("SA-1193 A1-2: import requirement labels", () => {
  it("every requirement maps to a real catalog SKU through the billing bridges", () => {
    // a Record over ImportColumnRequirement: tsc fails here until a new requirement has its SKU
    for (const sku of Object.values(IMPORT_REQUIREMENT_SKU)) {
      expect(ADDON_SKUS).toContain(sku);
    }
    expect(IMPORT_REQUIREMENT_SKU).toEqual({
      MSRP: "MSRP",
      TOBACCO_DEALER: "REGULATED_ITEMS",
      FORECASTING: "FORECASTING",
    });
  });

  it("reads the tenant's catalog version the way the billing route does, and returns its SKU names", async () => {
    const { svc, entitlements, catalog } = build(V11_ADDON_SEEDS);
    await expect(svc.labels()).resolves.toEqual({
      MSRP: "MSRP on invoices",
      TOBACCO_DEALER: "Regulated items",
      FORECASTING: "Forecasting",
    });
    expect(entitlements.resolve).toHaveBeenCalledWith(TENANT);
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("pv-7");
    expect(catalog.getPublishedCatalog).not.toHaveBeenCalled();
  });

  it("a renamed SKU in the tenant's version is what the import says (never a typed name)", async () => {
    const renamed = V11_ADDON_SEEDS.map((s) =>
      s.sku === "REGULATED_ITEMS" ? { ...s, name: "Acme regulated goods" } : s,
    );
    const { svc } = build(renamed);
    expect((await svc.labels()).TOBACCO_DEALER).toBe("Acme regulated goods");
  });

  it("a SKU missing from the tenant's version falls back to the published catalog, then to the SKU code", async () => {
    const tenantSkus = V11_ADDON_SEEDS.filter((s) => s.sku !== "FORECASTING");
    const { svc, catalog } = build(tenantSkus);
    expect((await svc.labels()).FORECASTING).toBe("Forecasting");
    expect(catalog.getPublishedCatalog).toHaveBeenCalledTimes(1);

    expect(requirementLabels([], []).TOBACCO_DEALER).toBe("REGULATED_ITEMS");
  });

  it("the billing route's own lookup is the one this mirrors (source pin)", () => {
    const src = readFileSync(join(__dirname, "../billing/subscription.service.ts"), "utf8");
    expect(src).toContain("this.catalog.getVersionForTenant(ent.planVersionId)");
    expect(src).toMatch(/name: sku\?\.name \?\? code/);
  });
});
