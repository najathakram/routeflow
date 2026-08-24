/**
 * The tenant's "Tobacco" regulated type — the compliance-pack anchor.
 *
 * Identification is BY NAME (case-insensitive "Tobacco"): the Phase-4 W1
 * backfill seeded exactly one such TrackedCategory per tenant that had
 * isTobacco products, and the consolidation deliberately avoids a schema
 * marker column. Renaming that category away from "Tobacco" detaches the
 * mirror sync; apps/api/scripts/backfill-tobacco-category.mjs re-heals it.
 *
 * Product.isTobacco is a DERIVED MIRROR of membership in this type (write-sync,
 * 2026-08-24 consolidation): every write that changes Product.trackedCategoryId
 * recomputes the flag, and an isTobacco-only PATCH is sugar for an assign/
 * unassign. Readers (tobacco reports/analytics exclusion) still consume the
 * flag — do not change them without re-proving report byte-equivalence.
 */
export const TOBACCO_CATEGORY_NAME = "Tobacco";

/**
 * Exact modulo case — deliberately NOT trimmed. The DB-side matchers
 * (`ProductsService.findTobaccoCategory`, `scripts/backfill-tobacco-category.mjs`)
 * use Prisma's `{ equals, mode: "insensitive" }`, which cannot trim, so a
 * trimming helper would disagree with them: a category literally named
 * `" Tobacco "` would read as the anchor everywhere the name is already in hand
 * (serialize, assignProducts) while every lookup missed it — and the quick-toggle
 * would seed a SECOND "Tobacco" type, splitting the tenant's tobacco products
 * across two regulated types. Both definitions must stay exact-modulo-case.
 */
export function isTobaccoCategoryName(name: string | null | undefined): boolean {
  return (name ?? "").toLowerCase() === TOBACCO_CATEGORY_NAME.toLowerCase();
}
