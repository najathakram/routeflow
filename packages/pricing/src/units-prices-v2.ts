/**
 * Units program S6 (PLAN §1.2; SA-795 (b), (g), (h)): the shared constants of the units/prices v2
 * schema. Constants only, and nothing reads them yet: they live HERE (not @routeflow/types) because
 * their readers (priceSource, the unit-default resolver, the settings writers) run in the API, which
 * may value-import only this compiled package (L-303).
 */

// ── Unit refs: where an order or invoice unit points ────────────────────────────────────────────

/** The pack row stored on Product itself (unit/packLabel, unitsPerBox, pricePerUnit, tiers). */
export const UNIT_REF_PACK = "pack" as const;
/** The implicit base unit (Piece; Product.baseUnitLabel). */
export const UNIT_REF_BASE = "base" as const;
/**
 * `Product/CustomerPrice/ProductTierUnit.orderUnitRef|invoiceUnitRef`, `CustomerUnitPrice.unitRef`:
 * a keyword, or a `ProductUnit.id` (a uuid; TEXT, no FK: a ref to a deleted unit is skipped and the
 * next scope wins, PLAN §1.2). Never a view `label:` ref: a DB CHECK refuses it (SA-796 R-3). The
 * `UnitRef` type itself, `TierRules` and `DEFAULT_TIER_RULES` are the units core's (price-ladder.ts).
 */
export const UNIT_REF_KEYWORDS = [UNIT_REF_PACK, UNIT_REF_BASE] as const;
export type UnitRefKeyword = (typeof UNIT_REF_KEYWORDS)[number];

export function isUnitRefKeyword(ref: string): ref is UnitRefKeyword {
  return (UNIT_REF_KEYWORDS as readonly string[]).includes(ref);
}

// ── Product.packAuto: which pack price cells are Auto (SA-795 (b)) ──────────────────────────────

/**
 * Bit order: bit 0 = Retail (pricePerUnit), bits 1-4 = priceTier2-5. A set bit = that cell is Auto;
 * `priceSource()` is its only reader. Fold A2: while the 0-fallback gives the same value, an Auto
 * tier stores 0 with its bit set, never a copied number.
 */
export const PACK_AUTO_BITS = Object.freeze({
  pricePerUnit: 1,
  priceTier2: 2,
  priceTier3: 4,
  priceTier4: 8,
  priceTier5: 16,
} as const);
export type PackAutoCell = keyof typeof PACK_AUTO_BITS;
/** Every bit set; the DB CHECK is `"packAuto" BETWEEN 0 AND 31`. */
export const PACK_AUTO_ALL = 31;

// ── Dark settings rows (SystemConfig; registered in @routeflow/types SETTINGS_REGISTRY) ──────────

export const TIER_RULES_SETTING_KEY = "pricing.tierRules" as const;
export const ORDER_UNIT_SETTING_KEY = "units.orderUnit" as const;
export const INVOICE_UNIT_SETTING_KEY = "units.invoiceUnit" as const;

/** Business order unit: a mode, or a named unit (TenantUnit id). Fills NEW products only. */
export const ORDER_UNIT_BUSINESS_MODES = ["pack", "smallest"] as const;
export type OrderUnitBusinessValue = (typeof ORDER_UNIT_BUSINESS_MODES)[number] | (string & {});
export const DEFAULT_ORDER_UNIT: OrderUnitBusinessValue = "pack";

/** Business invoice unit: a mode, or a named unit (TenantUnit id). Display only (SA-795 (g)). */
export const INVOICE_UNIT_BUSINESS_MODES = ["legacy", "smallest", "ordered", "pack"] as const;
export type InvoiceUnitBusinessValue = (typeof INVOICE_UNIT_BUSINESS_MODES)[number] | (string & {});
/**
 * The registry's one default, and what an unset row reads: `legacy` = today's output, byte for byte
 * (PLAN M4, owner Q5). New tenants are meant to start on `smallest`; the signup writer that stamps it
 * ships with the invoice-unit slice (S23), since a settings row cannot tell existing from new.
 */
export const DEFAULT_INVOICE_UNIT: InvoiceUnitBusinessValue = "legacy";
export const NEW_TENANT_INVOICE_UNIT: InvoiceUnitBusinessValue = "smallest";
