/**
 * SA-1099 A-8 tripwire: two gaps in `subscribe`'s target-plan judgement are dormant only because of today's data (#4214
 * reader B notes 1 and 2). They stay dormant until a catalog or registry change makes them reachable; this spec reads
 * the SHIPPED constants (the newest catalog seeds, the registry, the self-serve list) and goes red at that moment, so
 * the LATER row is done in the PR that turns it red, not forgotten.
 */
import fs from "node:fs";
import path from "node:path";
import { V13_ADDON_SEEDS } from "../../prisma/plan-catalog-v13.definitions";
import { FEATURE_REGISTRY } from "./feature-registry";
import { SELF_SERVICE_ADDON_SKUS } from "./plan-catalog.constants";

const selfServe = new Set<string>(SELF_SERVICE_ADDON_SKUS);

describe("SA-1099 A-8: the dormant gaps in subscribe's target-plan judgement", () => {
  it("T-0: v13 is the newest plan-catalog definitions file, so T-1 reads the newest add-on seeds", () => {
    const versions = fs
      .readdirSync(path.join(__dirname, "../../prisma"))
      .map((name) => /^plan-catalog-v(\d+)\.definitions\.ts$/.exec(name)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(versions).toContain(13); // not vacuous
    if (Math.max(...versions) !== 13) {
      throw new Error(
        "A newer plan-catalog definitions file exists: point T-1 at its add-on seeds (SA-1099 A-8) before this ships.",
      );
    }
  });

  it("T-1: no two self-serve flag-granting SKUs grant the same flag", () => {
    const seen = new Map<string, string>();
    const shared: string[] = [];
    let walked = 0;
    for (const s of V13_ADDON_SEEDS) {
      if (!selfServe.has(s.sku) || s.meteredKey || s.capacityPerUnit) continue; // capacity SKUs grant no flag
      walked += 1;
      for (const flag of s.grantsFlags) {
        if (seen.has(flag)) shared.push(`${flag}: ${seen.get(flag)} and ${s.sku}`);
        else seen.set(flag, s.sku);
      }
    }
    expect(walked).toBeGreaterThan(0); // not vacuous: FORECASTING is the flag-granting self-serve SKU today
    if (shared.length > 0) {
      throw new Error(
        "Two self-serve add-ons now grant the same flag: subscribe's target preview must use the desired add-on set (SA-1099 A-8, note 1) before this ships.",
      );
    }
  });

  it("T-2: no registry row billed by a self-serve SKU declares requires", () => {
    const billed = FEATURE_REGISTRY.filter((f) => f.billing.skus.some((sku) => selfServe.has(sku)));
    expect(billed.length).toBeGreaterThan(0); // not vacuous: the FORECASTING-billed rows
    const withRequires = billed.filter((f) => f.requires !== undefined).map((f) => f.key);
    if (withRequires.length > 0) {
      throw new Error(
        "A self-serve add-on now has a requires: heldStateRefusal's requires half must judge asPlan (SA-1099 A-8, note 2) before this ships.",
      );
    }
  });
});
