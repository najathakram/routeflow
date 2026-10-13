import * as fs from "fs";
import * as path from "path";

/**
 * B297 row 355 (SA-734r2 r-note 6): STRUCTURAL pin of every `promos:` ARGUMENT site in production source.
 * A split product (one product on several lines) earns its BUY_N_GET_M free units on the COMBINED quantity,
 * allocated oldest line first, through `product-free-units.ts` (`reallocateFreeUnits`). Each writer that
 * passes a live promotion list is registered below with the settle that covers it; a NEW `promos:` argument
 * site fails this spec until it is registered, so a new line writer can't re-introduce the per-line rescale.
 */
const SRC = path.resolve(__dirname, "..");

/** file (relative to src) -> the `promos:` argument expressions it passes, and the settle covering each. */
const REGISTRY: Record<string, Array<{ arg: string; settledBy: string }>> = {
  "orders/orders.service.ts": [
    {
      arg: "bogoPromos",
      settledBy: "mergeAllPendingForCustomer -> buildMergeLineWrites -> allocateSplitFreeUnits",
    },
    {
      arg: "bogoPromos",
      settledBy: "forceConsolidateCustomer -> buildMergeLineWrites -> allocateSplitFreeUnits",
    },
    {
      arg: "bogoPromos",
      settledBy: "updateOrderItems stored-price qty edit -> settleSplitFreeUnits at the tail",
    },
    {
      arg: "buyerPromos",
      settledBy: "approveChangeRequestAtStop -> settleSplitFreeUnits before the totals",
    },
    {
      arg: "buyerPromos",
      settledBy: "approveChangeRequestAtStop -> settleSplitFreeUnits before the totals",
    },
  ],
  "orders/merge-line-writes.ts": [
    {
      arg: "opts.promos",
      settledBy: "mergeBoxedContributions per group, then allocateSplitFreeUnits over the product",
    },
  ],
  "orders/buyer-merge-pricing.ts": [
    {
      arg: "bogo?.promos ?? []",
      settledBy:
        "mergeBoxedContributions: one group of one product; the split is allocateSplitFreeUnits",
    },
  ],
  "orders/product-free-units.ts": [
    {
      arg: "[...opts.promos]",
      settledBy: "THE home: rescaleBogoFreeUnits on the combined whole units",
    },
  ],
  "orders/replace-all-line-build.ts": [
    {
      arg: "ctx.bogoPromos",
      settledBy: "operator replace-all -> settleSplitFreeUnits at the updateOrderItems tail",
    },
  ],
};

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) productionFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(spec|test|db\.spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** `promos: <expr>,` passed as an argument (a type declaration is `promos: Type[];`). */
function promosArgs(file: string): string[] {
  const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return [...code.matchAll(/^\s*promos:\s+([^;\n]+?),?\s*$/gm)]
    .map((m) => m[1].trim())
    .filter((expr) => !/^(PromotionRule\[\]|Array<|ReadonlyArray<)/.test(expr));
}

describe("every `promos:` argument site is registered with the settle that covers it", () => {
  const found = new Map<string, string[]>();
  for (const f of productionFiles(SRC)) {
    const args = promosArgs(f);
    if (args.length) found.set(path.relative(SRC, f).replace(/\\/g, "/"), args);
  }

  it("the production sites are exactly the registered ones", () => {
    const registered = Object.fromEntries(
      Object.entries(REGISTRY).map(([f, sites]) => [f, sites.map((s) => s.arg)]),
    );
    expect(Object.fromEntries(found)).toEqual(registered);
  });

  it("every registered site names its settle", () => {
    for (const sites of Object.values(REGISTRY))
      for (const s of sites) expect(s.settledBy.length).toBeGreaterThan(10);
  });

  it("the settle homes exist and are the only free-unit allocators", () => {
    const home = fs.readFileSync(path.join(SRC, "orders/product-free-units.ts"), "utf8");
    expect(home).toMatch(/export function reallocateFreeUnits/);
    // allocateFreeUnits (the oldest-first allocation) is called from the core only, never re-implemented.
    const callers = productionFiles(SRC)
      .filter((f) => /\ballocateFreeUnits\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["orders/product-free-units.ts", "orders/split-promo-group.ts"]);
  });
});
