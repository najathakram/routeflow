import {
  BULK_RESTRICTION_MAX_PRODUCTS,
  US_STATES,
  type BulkRestrictionRequest,
  type ProductLimitDto,
} from "@routeflow/types";

/**
 * State portal limits (state-restrictions UX spec): every exact sentence the "Limit in portal…" flow shows, and the
 * request builder, in one place. Wire shapes are `@routeflow/types` (restrictions-admin.ts).
 */

export type LimitScope =
  | { kind: "products"; productIds: string[] }
  | { kind: "category"; categoryId: string; categoryName: string; productCount: number };

export const LIMIT_MAX = BULK_RESTRICTION_MAX_PRODUCTS;
export const UNDO_REASON = "Undone right after creating";
export const UNDO_VISIBLE_MS = 10_000;
export const LIFT_DEFAULT_REASON = "Limit lifted";
export const LIMIT_SAVE_FAILED = "Couldn't save. Nothing was changed. Try again.";
export const LIMIT_TOO_MANY = `Select up to ${LIMIT_MAX} products, or limit a whole category instead.`;

const NAME = new Map(US_STATES.map((s) => [s.code, s.name]));
export const stateLabel = (code: string) => NAME.get(code.toUpperCase()) ?? code;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function dialogTitle(scope: LimitScope): string {
  return scope.kind === "category"
    ? `Limit “${scope.categoryName}” in your portal`
    : `Limit ${plural(scope.productIds.length, "product", "products")} in your portal`;
}

/** "Texas" | "3 states" for a state choice; null for everyone. */
export function whoLabel(states: string[] | null): string | null {
  if (states === null) return null;
  if (states.length === 1) return stateLabel(states[0]);
  return `${states.length} states`;
}

export function primaryLabel(states: string[] | null): string {
  if (states === null) return "Hide from everyone";
  if (states.length === 0) return "Hide from…";
  return `Hide from ${whoLabel(states)}`;
}

export function liveLine(scope: LimitScope, states: string[] | null, legalBan = false): string {
  if (states !== null && states.length === 0) return "";
  const who =
    states === null
      ? "No portal customer"
      : states.length === 1
        ? `Customers in ${stateLabel(states[0])}`
        : `Customers in ${states.map(stateLabel).join(", ")}`;
  if (scope.kind === "category")
    return `${who} won't see the ${scope.productCount} products labelled ${scope.categoryName}, or any you label later.`;
  const what = `these ${scope.productIds.length} products`;
  // A legal ban (surface ALL) reaches staff too (row 510: a warning and a reason), so the line must not promise staff can still sell them freely.
  const tail = legalBan
    ? "Staff are warned and must give a reason to sell them."
    : "Your staff can still sell them.";
  return `${who} won't see ${what} in the portal. ${tail}`;
}

export function noStateLine(count: number): string {
  return `${plural(count, "customer has", "customers have")} no state on file, so they'll still see them.`;
}

export function doneTitle(
  scope: LimitScope,
  states: string[] | null,
  created: number,
  skipped: number,
): string {
  const audience =
    states === null ? "all portal customers" : `${whoLabel(states)} portal customers`;
  if (scope.kind === "category")
    return created === 0
      ? `“${scope.categoryName}” was already hidden from ${audience}`
      : `“${scope.categoryName}” hidden from ${audience}`;
  if (created === 0)
    return `Nothing changed. ${plural(skipped, "product was", "products were")} already hidden from ${audience}.`;
  const base = `${plural(created, "product", "products")} hidden from ${audience}`;
  return skipped > 0 ? `${base}. ${skipped} already ${skipped === 1 ? "was" : "were"}.` : base;
}

export function undoneTitle(states: string[] | null, lifted: number, scope: LimitScope): string {
  if (scope.kind === "category") return `“${scope.categoryName}” limit removed`;
  const what = plural(lifted, "product", "products");
  return states === null
    ? `Limit removed from ${what}`
    : `${whoLabel(states)} limit removed from ${what}`;
}

/** The request body for a dialog choice (pure, so the surface/jurisdiction rule has one home). */
export function buildBulkRequest(args: {
  scope: LimitScope;
  states: string[] | null;
  legalBan: boolean;
  note: string;
}): BulkRestrictionRequest {
  const { scope, states, legalBan, note } = args;
  const reason = note.trim();
  return {
    ...(scope.kind === "category"
      ? { categoryId: scope.categoryId }
      : { productIds: scope.productIds }),
    jurisdiction: states === null ? "FEDERAL" : "STATE",
    // FEDERAL (hide from everyone) carries no states; STATE carries the picked USPS codes
    states: states === null ? [] : states.map((s) => s.toUpperCase()),
    surface: legalBan ? "ALL" : "BUYER_PORTAL",
    ...(reason ? { reason } : {}),
  };
}

/** A product-page chip: what the rule does to portal customers. */
export function limitChipText(l: Pick<ProductLimitDto, "jurisdiction" | "states">): string {
  if (l.jurisdiction === "FEDERAL" || l.states.length === 0)
    return "Hidden from all portal customers";
  if (l.states.length <= 3)
    return `Not offered in ${l.states.map((c) => c.toUpperCase()).join(", ")}`;
  return `Not offered in ${l.states.length} states`;
}

/** "via Vapes" when the rule is inherited from a category or a parent product; null when it targets this product. */
export function limitViaText(l: Pick<ProductLimitDto, "via" | "viaLabel">): string | null {
  if (l.via === "PRODUCT") return null;
  if (l.viaLabel) return `via ${l.viaLabel}`;
  return l.via === "PARENT" ? "via parent" : "via category";
}
