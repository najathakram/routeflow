import { uniqueViolationConstraints } from "../common/prisma-unique";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * #2717 M2 (SA-572 I2/I3/I6, SA-574 Q1/Q10): the pure rules of a recipe — no I/O. The service loads
 * the rows; these functions decide. Every rejection is `RECIPE_INVALID` with a `reason` a client
 * (and a spec) can branch on: 400 for a shape rule, 409 for a product that already has a recipe.
 */
export type RecipeInvalidReason =
  | "UNITS_PER_PACK_INVALID"
  | "NO_COMPONENTS"
  | "QTY_INVALID"
  | "DUPLICATE_COMPONENT"
  | "COMPONENT_NOT_FOUND"
  | "COMPONENT_INACTIVE"
  | "COMPONENT_IS_RECIPE"
  | "COMPONENT_NOT_VARIANT"
  | "CATEGORY_MISMATCH"
  | "QTY_SUM_MISMATCH"
  | "PACK_SIZE_MISMATCH"
  | "FAMILY_IS_VARIANT"
  | "RECIPE_PRODUCT_IS_FAMILY"
  | "RECIPE_PRODUCT_HAS_PARENT"
  | "RECIPE_PRODUCT_HAS_VARIANTS"
  | "RECIPE_PRODUCT_HAS_RECIPE";

export function recipeInvalid(
  reason: RecipeInvalidReason,
  message: string,
  status: 400 | 409 = 400,
): BadRequestException | ConflictException {
  const body = { code: API_ERROR_CODES.RECIPE_INVALID, reason, message };
  return status === 409 ? new ConflictException(body) : new BadRequestException(body);
}

/** The slice of a Product row the rules read. */
export interface RuleProduct {
  id: string;
  parentProductId: string | null;
  kind: string;
  isActive: boolean;
  trackedCategoryId: string | null;
  unitsPerBox: number | null;
  familyPriceOverride: boolean;
}

export interface ShapeInput {
  unitsPerPack: number;
  family: RuleProduct;
  recipeProduct: RuleProduct;
  /** Variants of the recipe product (must be 0) — counted by the caller. */
  recipeProductVariantCount: number;
  /** The caller's request, in order. `product` is what the tenant-scoped lookup found (or nothing). */
  components: Array<{ componentProductId: string; qty: number; product: RuleProduct | undefined }>;
}

/** Rules that depend only on the recipe product and the family (checked before the components). */
export function assertRecipeProducts(input: {
  family: RuleProduct;
  recipeProduct: RuleProduct;
  recipeProductVariantCount: number;
}): void {
  const { family, recipeProduct } = input;
  if (family.parentProductId) {
    throw recipeInvalid("FAMILY_IS_VARIANT", "A recipe's family must be a standalone product.");
  }
  if (recipeProduct.id === family.id) {
    throw recipeInvalid("RECIPE_PRODUCT_IS_FAMILY", "A recipe product cannot be its own family.");
  }
  if (recipeProduct.parentProductId) {
    throw recipeInvalid(
      "RECIPE_PRODUCT_HAS_PARENT",
      "A product that is a variant of another product cannot be a recipe product.",
      409,
    );
  }
  if (input.recipeProductVariantCount > 0) {
    throw recipeInvalid(
      "RECIPE_PRODUCT_HAS_VARIANTS",
      "A product that has variants cannot be a recipe product.",
      409,
    );
  }
}

/**
 * I2 (+ I6, Q10) on a draft's contents: components are distinct, active, non-recipe variants of the
 * family in the family's tracked category, whole positive quantities that sum to `unitsPerPack`,
 * and `unitsPerPack` equals the family's `unitsPerBox` unless the recipe product owns its price
 * (`familyPriceOverride` — a different box size is only legal with its own price).
 */
export function assertRecipeShape(input: ShapeInput): void {
  const { unitsPerPack, family, recipeProduct, components } = input;
  if (!Number.isInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw recipeInvalid("UNITS_PER_PACK_INVALID", "unitsPerPack must be a whole number above 0.");
  }
  if (components.length === 0) {
    throw recipeInvalid("NO_COMPONENTS", "A recipe needs at least one component.");
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const c of components) {
    if (!Number.isInteger(c.qty) || c.qty <= 0) {
      throw recipeInvalid(
        "QTY_INVALID",
        "Every component quantity must be a whole number above 0.",
      );
    }
    if (seen.has(c.componentProductId)) {
      throw recipeInvalid("DUPLICATE_COMPONENT", "A product can appear only once in a recipe.");
    }
    seen.add(c.componentProductId);
    if (!c.product) {
      throw recipeInvalid("COMPONENT_NOT_FOUND", "A component product was not found.");
    }
    if (!c.product.isActive) {
      throw recipeInvalid("COMPONENT_INACTIVE", "A component product is inactive.");
    }
    if (c.product.kind === "RECIPE") {
      throw recipeInvalid("COMPONENT_IS_RECIPE", "A recipe cannot contain another recipe.");
    }
    if (c.product.parentProductId !== family.id) {
      throw recipeInvalid(
        "COMPONENT_NOT_VARIANT",
        "Every component must be a variant of the family.",
      );
    }
    if ((c.product.trackedCategoryId ?? null) !== (family.trackedCategoryId ?? null)) {
      throw recipeInvalid(
        "CATEGORY_MISMATCH",
        "Every component must be in the same tracked category as the family.",
      );
    }
    sum += c.qty;
  }
  if (sum !== unitsPerPack) {
    throw recipeInvalid(
      "QTY_SUM_MISMATCH",
      "The component quantities must add up to unitsPerPack.",
    );
  }
  if (!recipeProduct.familyPriceOverride && unitsPerPack !== (family.unitsPerBox ?? null)) {
    throw recipeInvalid(
      "PACK_SIZE_MISMATCH",
      "unitsPerPack must equal the family's box size unless the recipe product has its own price.",
    );
  }
}

/** ConflictException 409 RECIPE_IMMUTABLE — the one refusal for any write to a non-DRAFT recipe. */
export function recipeImmutable(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RECIPE_IMMUTABLE,
    message: "This recipe version is no longer a draft. Create a new version to change it.",
  });
}

/** SA-579: the guard every component write goes through. */
export function assertRecipeEditable(recipe: { status: string }): void {
  if (recipe.status !== "DRAFT") throw recipeImmutable();
}

export function recipeActiveConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RECIPE_ACTIVE_CONFLICT,
    message: "Another change to this recipe product's active recipe landed first. Retry.",
  });
}

export function recipeVersionConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RECIPE_VERSION_CONFLICT,
    message: "Another new version of this recipe landed first. Retry.",
  });
}

const RECIPE_CONSTRAINTS: ReadonlyArray<{
  which: "activeFor" | "productVersion";
  names: ReadonlySet<string>;
  fields: ReadonlySet<string>;
}> = [
  {
    which: "activeFor",
    names: new Set(["Recipe_activeFor_key"]),
    fields: new Set(["activeFor"]),
  },
  {
    which: "productVersion",
    names: new Set(["Recipe_productId_version_key"]),
    fields: new Set(["productId", "version"]),
  },
];

/**
 * Which Recipe unique constraint a P2002 names, or null. The `meta` comes in two shapes (the L-072-
 * class trap M1 hit on barcodes): the native engine's `meta.target` (fields or a constraint name),
 * and, with the Prisma pg DRIVER ADAPTER this API runs, no `target` at all — the constraint rides in
 * `meta.driverAdapterError.cause.constraint` as `{ index }` or `{ fields }`. Exact names and exact
 * field sets only, never substrings.
 */
export function recipeUniqueViolation(e: unknown): "activeFor" | "productVersion" | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return null;
  const u = uniqueViolationConstraints(e);
  if (!u) return null;
  const candidates: Array<{ name?: string; fields?: string[] }> = u.names.map((name) => ({ name }));
  if (u.fields.length) candidates.push({ fields: u.fields });
  for (const spec of RECIPE_CONSTRAINTS) {
    for (const c of candidates) {
      if (c.name && spec.names.has(c.name)) return spec.which;
      if (c.fields) {
        const have = new Set(c.fields);
        if (have.size === spec.fields.size && [...spec.fields].every((f) => have.has(f))) {
          return spec.which;
        }
      }
    }
  }
  return null;
}

/** The statuses that hold a recipe's invariants: DRAFT and ACTIVE (RETIRED locks nothing). */
const OPEN_RECIPE_STATUS = { in: ["DRAFT", "ACTIVE"] as Array<"DRAFT" | "ACTIVE"> };

/** I6 helper: the query that says whether a product sits in a non-RETIRED recipe in any role. */
export function openRecipeWhere(productId: string) {
  return {
    status: OPEN_RECIPE_STATUS,
    OR: [
      { productId },
      { familyProductId: productId },
      { components: { some: { componentProductId: productId } } },
    ],
  };
}

/** `openRecipeWhere` for a set of products (any of them, in any role) — the bulk writers' form. */
export function openRecipeWhereAny(productIds: string[]) {
  return {
    status: OPEN_RECIPE_STATUS,
    OR: [
      { productId: { in: productIds } },
      { familyProductId: { in: productIds } },
      { components: { some: { componentProductId: { in: productIds } } } },
    ],
  };
}

/** How many DISTINCT `movingIds` are held (any role) by the given open recipes. A count, never ids. */
export function countLockedProducts(
  movingIds: string[],
  recipes: Array<{
    productId: string;
    familyProductId: string;
    components?: Array<{ componentProductId: string }>;
  }>,
): number {
  const held = new Set<string>();
  for (const r of recipes) {
    held.add(r.productId);
    held.add(r.familyProductId);
    for (const c of r.components ?? []) held.add(c.componentProductId);
  }
  return new Set(movingIds.filter((id) => held.has(id))).size;
}

/** 409 RECIPE_CATEGORY_LOCKED; `lockedCount` = how many products are locked (SA-587a: count only). */
export function recipeCategoryLocked(lockedCount = 1): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RECIPE_CATEGORY_LOCKED,
    lockedCount,
    message:
      "This product is part of a recipe that is not retired, so its tracked category cannot change.",
  });
}

/** 409 RECIPE_FAMILY_LOCKED (SA-584 B2 a): a re-parent or a box-size change an open recipe forbids. */
export function recipeFamilyLocked(reason: "PARENT" | "UNITS_PER_BOX"): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RECIPE_FAMILY_LOCKED,
    reason,
    message:
      reason === "PARENT"
        ? "This product is a component of a recipe that is not retired, so it cannot leave its family."
        : "This product is the family or the recipe product of a recipe that is not retired, so its box size cannot change.",
  });
}
