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

/** Evaluates `expr` (JS, with `m` = the helper module and `input` = parsed INPUT) in one child. */
function evalHelper(expr: string, input: unknown) {
  const code = `import * as m from "${HELPER_HREF}"; const input = JSON.parse(process.env.INPUT);
    const out = await (async () => { ${expr} })(); console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, INPUT: JSON.stringify(input) },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const P = (id: string, isTobacco: boolean, trackedCategoryId: string | null) => ({
  id,
  name: `n-${id}`,
  isTobacco,
  trackedCategoryId,
});

describe("backfill-tobacco-category link planner (SA-587b, pure)", () => {
  const products = [
    P("free", true, null),
    P("locked", true, null),
    P("conf", true, "other"),
    P("mem", false, "tob"),
  ];
  const recipes = [
    {
      status: "ACTIVE",
      productId: "r",
      familyProductId: "f",
      components: [{ componentProductId: "locked" }],
    },
  ];

  it("plans link=[free], recipeLocked=[locked], conflict, flag; locked id is never in link", () => {
    const plan = evalHelper(
      `const c = m.tobaccoLinkCandidates(input.products);
       const p = m.planTobaccoLink({ tobaccoCat: input.cat, products: input.products, openRecipes: input.recipes });
       return { cand: c.map((x) => x.id), link: p.link.map((x) => x.id),
         locked: p.recipeLocked.map((x) => x.id), conflicts: p.conflicts.map((x) => x.id),
         flag: p.flag.map((x) => x.id), create: p.createCategory };`,
      { products, recipes, cat: { id: "tob", name: "Tobacco", active: true } },
    );
    expect(plan).toEqual({
      cand: ["free", "locked"],
      link: ["free"],
      locked: ["locked"],
      conflicts: ["conf"],
      flag: ["mem"],
      create: false,
    });
  });

  it("no category yet: create only when a FREE link row exists (all-locked creates nothing)", () => {
    const run = (prods: unknown[]) =>
      evalHelper(
        `const p = m.planTobaccoLink({ tobaccoCat: null, products: input.products, openRecipes: input.recipes });
         return { link: p.link.length, locked: p.recipeLocked.length, create: p.createCategory };`,
        { products: prods, recipes },
      );
    expect(run([P("free", true, null)])).toEqual({ link: 1, locked: 0, create: true });
    expect(run([P("locked", true, null)])).toEqual({ link: 0, locked: 1, create: false });
  });

  it("executePlan writes ONLY plan.link ids (never a recipe-locked id) and only plan.flag ids", () => {
    const calls = evalHelper(
      `const log = [];
       const tx = { trackedCategory: { create: async () => ({ id: "new" }) },
         product: { updateMany: async (a) => { log.push(a); } } };
       const plan = m.planTobaccoLink({ tobaccoCat: input.cat, products: input.products, openRecipes: input.recipes });
       await m.applyTobaccoPlan(tx, { tenant: { id: "t" }, ...plan });
       return log;`,
      { products, recipes, cat: { id: "tob", name: "Tobacco", active: true } },
    );
    expect(calls).toEqual([
      { where: { id: { in: ["free"] } }, data: { trackedCategoryId: "tob" } },
      { where: { id: { in: ["mem"] } }, data: { isTobacco: true } },
    ]);
    expect(JSON.stringify(calls)).not.toContain("locked");
  });

  it("all-locked plan writes nothing; a created category id is what link points at", () => {
    const out = evalHelper(
      `const log = []; const creates = [];
       const tx = { trackedCategory: { create: async (a) => { creates.push(a.data.name); return { id: "new" }; } },
         product: { updateMany: async (a) => { log.push(a); } } };
       await m.applyTobaccoPlan(tx, { tenant: { id: "t" }, ...m.planTobaccoLink({ tobaccoCat: null, products: [input.locked], openRecipes: input.recipes }) });
       const tx2 = { trackedCategory: tx.trackedCategory, product: { updateMany: async (a) => { log.push(a); } } };
       await m.applyTobaccoPlan(tx2, { tenant: { id: "t" }, ...m.planTobaccoLink({ tobaccoCat: null, products: [input.free], openRecipes: [] }) });
       return { log, creates };`,
      { locked: P("locked", true, null), free: P("free", true, null), recipes },
    );
    expect(out).toEqual({
      log: [{ where: { id: { in: ["free"] } }, data: { trackedCategoryId: "new" } }],
      creates: ["Tobacco"],
    });
  });

  it("--all-tenants summary totals recipe-locked as a COUNT only", () => {
    const out = evalHelper(`return m.summarizePlans(input.plans);`, {
      plans: [
        { link: [1, 2], flag: [1], createCategory: true, conflicts: [1], recipeLocked: [1, 2, 3] },
        { link: [], flag: [], createCategory: false, conflicts: [], recipeLocked: [1] },
      ],
    });
    expect(out).toEqual({ writes: 4, conflicts: 1, recipeLocked: 4 });
  });
});

describe("backfill-tobacco-category planTobaccoTenant glue (SA-587b exact-return pin)", () => {
  const cat = { id: "tob", name: "Tobacco", active: true };
  const products = [
    P("free", true, null),
    P("locked", true, null),
    P("conf", true, "other"),
    P("mem", false, "tob"),
  ];
  const openRecipes = [
    {
      status: "ACTIVE",
      productId: "r",
      familyProductId: "f",
      components: [{ componentProductId: "locked" }],
    },
  ];

  it("returns EXACTLY { tenant, ...planTobaccoLink }: no locked id re-added, no extra keys", () => {
    const out = evalHelper(
      `const db = {
         trackedCategory: { findFirst: async () => input.cat },
         product: { findMany: async () => input.products },
         recipe: { findMany: async () => input.openRecipes },
       };
       const tenant = { id: "t", slug: "s", status: "ACTIVE" };
       const got = await m.planTobaccoTenant(db, tenant);
       const want = { tenant, ...m.planTobaccoLink({ tobaccoCat: input.cat, products: input.products, openRecipes: input.openRecipes }) };
       return { got, want };`,
      { cat, products, openRecipes },
    );
    expect(out.got).toStrictEqual(out.want);
    expect(Object.keys(out.got).sort()).toEqual(
      [
        "conflicts",
        "createCategory",
        "flag",
        "link",
        "recipeLocked",
        "tenant",
        "tobaccoCat",
      ].sort(),
    );
    expect(out.got.link.map((p: { id: string }) => p.id)).toEqual(["free"]);
    expect(out.got.recipeLocked.map((p: { id: string }) => p.id)).toEqual(["locked"]);
    expect(out.got.link.map((p: { id: string }) => p.id)).not.toContain("locked");
  });
});

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
    expect(SCRIPT).toContain("planTobaccoTenant(prisma, tenant)");
    expect(SCRIPT).toContain("applyTobaccoPlan(");
    const lines = SCRIPT.split("\n").filter((l) => l.includes("recipe-locked ("));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/\.(id|name|slug)\b/);
    expect(SCRIPT).not.toMatch(/for \(const \w+ of (plan\.)?recipeLocked\)/);
    expect(SCRIPT).toMatch(/recipe-locked total|recipeLocked} recipe-locked/);
  });
});
