import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";

/**
 * #2717 M2 test 26 (SA-572 I11, L-205): documents never JOIN Recipe. Behavioural, not a text scrape
 * of the schema: the generated client's own datamodel says which models carry a relation field of
 * type Recipe/RecipeComponent, and MODEL_DOMAIN (split-prisma-schema.mjs) says which domain each
 * model belongs to. No sales or finance model may point at either recipe table; only Product,
 * Recipe and RecipeComponent themselves may.
 */
const SPLIT_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "split-prisma-schema.mjs");

function modelDomainMap(): Map<string, string> {
  const src = fs.readFileSync(SPLIT_SCRIPT, "utf8");
  const start = src.indexOf("const MODEL_DOMAIN = {");
  const end = start < 0 ? -1 : src.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error("MODEL_DOMAIN not found in the split script");
  return new Map(
    Array.from(src.slice(start, end).matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*"([a-z]+)",/gm)).map(
      (m) => [m[1], m[2]] as [string, string],
    ),
  );
}

const RECIPE_TYPES = new Set(["Recipe", "RecipeComponent"]);

describe("recipes: no document join (I11)", () => {
  const domains = modelDomainMap();

  it("maps Recipe and RecipeComponent to the catalog domain", () => {
    expect(domains.get("Recipe")).toBe("catalog");
    expect(domains.get("RecipeComponent")).toBe("catalog");
  });

  it("finds the models that reference a recipe table (non-vacuous)", () => {
    const referrers = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => RECIPE_TYPES.has(f.type)))
      .map((m) => m.name)
      .sort();
    expect(referrers).toEqual(["Product", "Recipe", "RecipeComponent"]);
  });

  it("no sales or finance model has a field of type Recipe or RecipeComponent", () => {
    const offenders = Prisma.dmmf.datamodel.models
      .filter((m) => ["sales", "finance"].includes(domains.get(m.name) ?? ""))
      .filter((m) => m.fields.some((f) => RECIPE_TYPES.has(f.type)))
      .map((m) => m.name);
    expect(offenders).toEqual([]);
  });

  // #2717 M3 (case 17): the component models and the line provenance columns are inside that scan.
  it("the component models are sales / finance models, so the scan above covers them", () => {
    expect(domains.get("OrderItemComponent")).toBe("sales");
    expect(domains.get("InvoiceItemComponent")).toBe("finance");
    const names = Prisma.dmmf.datamodel.models.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["OrderItemComponent", "InvoiceItemComponent"]));
  });

  it("recipeId on a line is a plain scalar: no relation to Recipe from OrderItem, InvoiceItem or a component model", () => {
    for (const name of ["OrderItem", "InvoiceItem", "OrderItemComponent", "InvoiceItemComponent"]) {
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
      expect(model).toBeDefined();
      expect(model?.fields.filter((f) => f.kind === "object" && RECIPE_TYPES.has(f.type))).toEqual(
        [],
      );
    }
    for (const name of ["OrderItem", "InvoiceItem"]) {
      const f = Prisma.dmmf.datamodel.models
        .find((m) => m.name === name)
        ?.fields.find((x) => x.name === "recipeId");
      // the runtime dmmf omits `isRequired` for optional scalars: assert "not required", not "false"
      expect(f).toMatchObject({ kind: "scalar", type: "String" });
      expect(f?.isRequired ?? false).toBe(false);
    }
  });
});
