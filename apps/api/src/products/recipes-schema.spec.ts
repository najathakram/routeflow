import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import {
  API_ERROR_CODES as SHARED_CODES,
  RECIPE_STATUS_VALUES,
  type RecipeDto,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * #2717 M2 tests 28-29 (SA-574 frozen schema). The generated client's datamodel keeps only
 * name/kind/type per field, so nullability, uniques and onDelete are read from the schema source
 * (the one place they are declared) — same approach as b297-rate-snapshot-schema.spec.ts.
 */
const CATALOG = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "prisma", "schema", "catalog.prisma"),
  "utf8",
);

function modelBlock(name: string): string {
  const start = CATALOG.indexOf(`\nmodel ${name} {`);
  if (start < 0) throw new Error(`model ${name} not in catalog.prisma`);
  return CATALOG.slice(start, CATALOG.indexOf("\n}", start));
}

function fieldsOf(name: string): Map<string, { kind: string; type: string }> {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  if (!model) throw new Error(`model ${name} not in Prisma.dmmf`);
  return new Map(model.fields.map((f) => [f.name, { kind: f.kind, type: f.type }]));
}

describe("Recipe schema shape (test 28)", () => {
  it("Recipe carries the frozen columns", () => {
    const f = fieldsOf("Recipe");
    for (const col of [
      "id",
      "tenantId",
      "productId",
      "familyProductId",
      "version",
      "unitsPerPack",
      "status",
      "activeFor",
      "effectiveFrom",
      "retiredAt",
      "createdById",
      "createdAt",
      "updatedAt",
    ]) {
      expect(f.has(col)).toBe(true);
    }
    expect(f.get("status")).toEqual({ kind: "enum", type: "RecipeStatus" });
  });

  it("Recipe: non-null tenantId, one version per product, one active recipe per product", () => {
    const block = modelBlock("Recipe");
    expect(block).toMatch(/^\s+tenantId\s+String\s*$/m);
    expect(block).toMatch(/^\s+activeFor\s+String\?\s*$/m);
    expect(block).toMatch(/@@unique\(\[productId, version\]\)/);
    expect(block).toMatch(/@@unique\(\[activeFor\]\)/);
  });

  it("RecipeComponent: non-null tenantId and one row per (recipe, component)", () => {
    const block = modelBlock("RecipeComponent");
    expect(block).toMatch(/^\s+tenantId\s+String\s*$/m);
    expect(block).toMatch(/@@unique\(\[recipeId, componentProductId\]\)/);
  });

  it("Product.familyPriceOverride defaults to false", () => {
    expect(fieldsOf("Product").get("familyPriceOverride")).toEqual({
      kind: "scalar",
      type: "Boolean",
    });
    expect(modelBlock("Product")).toMatch(/familyPriceOverride\s+Boolean\s+@default\(false\)/);
  });

  it("FKs: RESTRICT on the three product links, CASCADE from a recipe to its components", () => {
    const recipe = modelBlock("Recipe");
    const component = modelBlock("RecipeComponent");
    expect(recipe.match(/onDelete: Restrict/g) ?? []).toHaveLength(2);
    expect(component.match(/onDelete: Restrict/g) ?? []).toHaveLength(1);
    expect(component.match(/onDelete: Cascade/g) ?? []).toHaveLength(1);
    expect(recipe).not.toMatch(/onDelete: Cascade/);
  });
});

describe("Recipe codes and shared types (test 29)", () => {
  const NEW_CODES = [
    "RECIPE_IMMUTABLE",
    "RECIPE_CATEGORY_LOCKED",
    "RECIPE_ACTIVE_CONFLICT",
    "RECIPE_VERSION_CONFLICT",
    "RECIPE_INVALID",
    "FAMILY_PRICE_AUTHORITY",
  ] as const;

  it.each(NEW_CODES)("%s is in both error-code files with the same literal", (code) => {
    expect((API_ERROR_CODES as Record<string, string>)[code]).toBe(code);
    expect((SHARED_CODES as Record<string, string>)[code]).toBe(code);
  });

  it("RECIPE_STATUS_VALUES lists the three states in lifecycle order", () => {
    expect([...RECIPE_STATUS_VALUES]).toEqual(["DRAFT", "ACTIVE", "RETIRED"]);
  });

  it("RecipeDto is exported with the fields a client reads", () => {
    const dto: RecipeDto = {
      id: "r1",
      productId: "p1",
      familyProductId: "f1",
      version: 1,
      unitsPerPack: 12,
      status: "DRAFT",
      activeFor: null,
      effectiveFrom: null,
      retiredAt: null,
      components: [{ id: "c1", componentProductId: "v1", qty: 12, position: 0 }],
    };
    expect(dto.components[0].qty).toBe(12);
  });
});
