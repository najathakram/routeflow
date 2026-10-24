import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  isAddonIncludedAtPlan,
  resolveIncludedAtPlan,
  type IncludedAtPlanResolution,
} from "./plan-catalog.constants";

/**
 * B1102: a stored catalog `includedAtPlan` that no plan answers to (a typo) used to read as "bundled
 * nowhere", so the add-on billed on every plan. Every READER of a stored key now fails closed through
 * this module: a user-initiated path answers 409 `ADDON_CATALOG_INVALID` ({ sku, value } in the body);
 * a background path (webhook sync, checkout adoption, activation) SKIPS the add-on's Stripe item, logs
 * the sku and writes an audit row, and never throws the tenant's whole billing.
 */

/** Fixed tenant-facing sentence (no ids, no typed text). The web shows its own fixed copy for the code. */
export const ADDON_CATALOG_INVALID_MESSAGE =
  "This add-on can't be changed right now. Please contact support.";

/** The refusal body: also the shape of an `AddonRefusal` (reason CATALOG_INVALID). */
export interface AddonCatalogInvalid {
  code: string;
  message: string;
  reason: "CATALOG_INVALID";
  sku: string;
  value: string;
}

export function addonCatalogInvalid(sku: string, value: unknown): AddonCatalogInvalid {
  return {
    code: API_ERROR_CODES.ADDON_CATALOG_INVALID,
    message: ADDON_CATALOG_INVALID_MESSAGE,
    reason: "CATALOG_INVALID",
    sku,
    value: String(value),
  };
}

/** The 409 a user-initiated path throws. */
export function addonCatalogInvalidException(sku: string, value: unknown): ConflictException {
  return new ConflictException(addonCatalogInvalid(sku, value));
}

export type IncludedVerdict =
  | { kind: "INCLUDED" }
  | { kind: "NOT_INCLUDED" }
  | { kind: "CATALOG_INVALID"; sku: string; value: string };

/** Is `def` bundled free at `planKey`? An unparseable `includedAtPlan` is CATALOG_INVALID, not "no". */
export function includedAtPlanVerdict(
  def: { sku: string; includedAtPlan?: string | null },
  planKey: string | null | undefined,
): IncludedVerdict {
  const resolved: IncludedAtPlanResolution = resolveIncludedAtPlan(def.includedAtPlan);
  if (!resolved.ok)
    return { kind: "CATALOG_INVALID", sku: def.sku, value: String(def.includedAtPlan) };
  return isAddonIncludedAtPlan(resolved.plan, planKey)
    ? { kind: "INCLUDED" }
    : { kind: "NOT_INCLUDED" };
}
