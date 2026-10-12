import { US_STATES } from "@routeflow/types";
import { BULK_PORTAL_MAX } from "./product-portal-visibility-ui";

/**
 * State portal limits (state-restrictions UX spec): the contracts the web codes against and every exact sentence the
 * "Limit in portal…" flow shows, in one place. Wire shapes mirror the spec §5.6 names; the API branch exports the same
 * names from `@routeflow/types` and these re-point there when it lands.
 */

export interface BulkRestrictionRequest {
  /** 1..200 ids XOR `categoryId`. */
  productIds?: string[];
  categoryId?: string;
  jurisdiction: "FEDERAL" | "STATE";
  states?: string[];
  surface?: "ALL" | "BUYER_PORTAL";
  reason?: string;
}

export interface BulkRestrictionResponse {
  created: number;
  skipped: number;
  unknownStateCustomerCount: number;
  /** The rows this call created, so Undo lifts exactly them. */
  createdIds: string[];
}

export interface LiftBatchRequest {
  ids: string[];
  reason: string;
}

/** One rule binding a product, for the product page chips. `via` names where it was inherited from. */
export interface ProductLimitDto {
  id: string;
  jurisdiction: "FEDERAL" | "STATE";
  states: string[];
  surface: "ALL" | "BUYER_PORTAL";
  via: "PRODUCT" | "PARENT" | "CATEGORY";
  viaName: string | null;
  reason: string;
}

export type LimitScope =
  | { kind: "products"; productIds: string[] }
  | { kind: "category"; categoryId: string; categoryName: string; productCount: number };

export const LIMIT_MAX = BULK_PORTAL_MAX;
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

export function liveLine(scope: LimitScope, states: string[] | null): string {
  const what =
    scope.kind === "category"
      ? `the ${scope.productCount} products labelled ${scope.categoryName}, or any you label later`
      : `these ${scope.productIds.length} products`;
  if (states === null)
    return `No portal customer will see ${what} in the portal. Your staff can still sell them.`;
  if (states.length === 0) return "";
  const who =
    states.length === 1
      ? `Customers in ${stateLabel(states[0])}`
      : `Customers in ${states.map(stateLabel).join(", ")}`;
  return `${who} won't see ${what} in the portal. Your staff can still sell them.`;
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
  if (scope.kind === "category") return `“${scope.categoryName}” hidden from ${audience}`;
  const base = `${plural(created, "product", "products")} hidden from ${audience}`;
  return skipped > 0 ? `${base}. ${skipped} already ${skipped === 1 ? "was" : "were"}.` : base;
}

export function undoneTitle(states: string[] | null, lifted: number, scope: LimitScope): string {
  const where = states === null ? "everyone" : (whoLabel(states) ?? "");
  if (scope.kind === "category") return `“${scope.categoryName}” limit removed`;
  return `${where} limit removed from ${plural(lifted, "product", "products")}`;
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
    ...(states === null ? {} : { states: states.map((s) => s.toUpperCase()) }),
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
export function limitViaText(l: Pick<ProductLimitDto, "via" | "viaName">): string | null {
  if (l.via === "PRODUCT") return null;
  if (l.viaName) return `via ${l.viaName}`;
  return l.via === "PARENT" ? "via parent" : "via category";
}
