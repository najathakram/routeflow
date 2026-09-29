import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * SA-587b (#2717 M2 fold): the tobacco backfill's `link` step must skip every product that sits in a
 * non-RETIRED recipe (as the recipe product, the family, or a component) and report them as a
 * COUNT-ONLY `recipe-locked` bucket. The script is plain .mjs under bare node, so the pure helper
 * lives in scripts/lib/recipe-locked.mjs and is evaluated in one `node --input-type=module` child.
 * No database, no network.
 */
const API_DIR = path.resolve(__dirname, "../..");
const HELPER_HREF = pathToFileURL(path.join(API_DIR, "scripts/lib/recipe-locked.mjs")).href;
const SCRIPT = readFileSync(path.join(API_DIR, "scripts/backfill-tobacco-category.mjs"), "utf8");
const RULES = readFileSync(path.join(API_DIR, "src/products/recipe-rules.ts"), "utf8");

const SHIM = `
import * as m from "${HELPER_HREF}";
const products = [{ id: "a" }, { id: "b" }, { id: "c" }];
const recipes = JSON.parse(process.env.RECIPES);
const locked = m.lockedProductIds(recipes);
const out = m.partitionRecipeLocked(products, locked);
console.log(JSON.stringify({
  statuses: m.OPEN_RECIPE_STATUSES,
  free: out.free.map((p) => p.id),
  recipeLocked: out.recipeLocked.map((p) => p.id),
  where: m.openRecipeWhereAny(["a"]),
}));
`;

function run(recipes: unknown[]) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
    env: { ...process.env, RECIPES: JSON.stringify(recipes) },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("backfill-tobacco-category recipe-locked partition (SA-587b)", () => {
  it("a DRAFT-recipe product and an ACTIVE-recipe component are locked; the free one links", () => {
    const out = run([
      { status: "DRAFT", productId: "a", familyProductId: "x", components: [] },
      {
        status: "ACTIVE",
        productId: "y",
        familyProductId: "z",
        components: [{ componentProductId: "b" }],
      },
    ]);
    expect(out.free).toEqual(["c"]);
    expect(out.recipeLocked).toEqual(["a", "b"]);
  });

  it("a family membership locks; RETIRED-only membership does not", () => {
    const fam = run([{ status: "ACTIVE", productId: "y", familyProductId: "c", components: [] }]);
    expect(fam.recipeLocked).toEqual(["c"]);
    const retired = run([
      { status: "RETIRED", productId: "a", familyProductId: "b", components: [] },
    ]);
    expect(retired.recipeLocked).toEqual([]);
    expect(retired.free).toEqual(["a", "b", "c"]);
  });

  it("parity: the script's open statuses equal the API guard's OPEN_RECIPE_STATUS", () => {
    const m = /const OPEN_RECIPE_STATUS = \{ in: \[([^\]]*)\]/.exec(RULES);
    expect(m).not.toBeNull();
    const ts = m![1].match(/"([A-Z]+)"/g)!.map((s) => s.replace(/"/g, ""));
    const out = run([]);
    expect([...out.statuses].sort()).toEqual([...ts].sort());
    expect(out.where.status.in).toEqual(out.statuses);
    expect(out.where.OR).toHaveLength(3);
  });

  it("the link step uses the helper and prints a count-only recipe-locked bucket", () => {
    expect(SCRIPT).toMatch(/from "\.\/lib\/recipe-locked\.mjs"/);
    expect(SCRIPT).toContain("partitionRecipeLocked(");
    const lines = SCRIPT.split("\n").filter((l) => l.includes("recipe-locked ("));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/\.(id|name|slug)\b/);
    expect(SCRIPT).not.toMatch(/for \(const \w+ of (plan\.)?recipeLocked\)/);
  });
});
