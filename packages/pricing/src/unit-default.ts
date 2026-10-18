import { rowOf, type LadderView, type UnitRef } from "./price-ladder";

// Units and prices, pricing core C (PLAN product-units-pricing §1.6, owner requirement 12).
// Two separate defaults, each resolved at four scopes, the most specific wins:
//   customer (this product, this customer) > tier (this product, the customer's tier) > product > business.
// The ORDER unit is also the price anchor at that scope, so `resolveUnitDefault` returns the anchor with it and no
// caller re-derives it. The INVOICE unit only chooses what an invoice line shows and which code prints; it never moves a price.

export type UnitScope = "customer" | "tier" | "product" | "business" | "fallback";

/** What each scope holds for this product: a unit ref, a unit name, or a word (pack, smallest; invoice also legacy, ordered). */
export interface UnitScopes {
  customer?: string | null;
  tier?: string | null;
  product?: string | null;
  business?: string | null;
}

const SCOPE_ORDER = ["customer", "tier", "product", "business"] as const;

const smallestRef = (view: LadderView): UnitRef =>
  [...view.rows].sort((a, b) => a.factor - b.factor)[0].ref;

/** A scope value to a unit on this ladder, or null when the ladder has no such unit (a deleted unit, a name it lacks). */
function refOfValue(view: LadderView, value: string): UnitRef | null {
  const v = value.trim();
  if (!v) return null;
  const byRef = view.rows.find((r) => r.ref === v);
  if (byRef) return byRef.ref;
  const word = v.toLowerCase();
  if (word === "pack") return "pack";
  if (word === "smallest") return smallestRef(view);
  return view.rows.find((r) => r.label.trim().toLowerCase() === word)?.ref ?? null;
}

export interface SkippedScope {
  scope: Exclude<UnitScope, "fallback">;
  value: string;
}

export interface OrderUnitDefault {
  orderUnit: UnitRef;
  label: string;
  /** Always the same unit as `orderUnit`; `scope` says whose price anchors it (owner Q2/Q2b). */
  anchor: { unit: UnitRef; scope: UnitScope };
  scope: UnitScope;
  /** Scopes that held a value this ladder could not use, in the order they were tried. */
  skipped: SkippedScope[];
}

/**
 * The unit staff and buyers order in. A value whose unit is gone (T22) is skipped and the next scope wins; when no scope
 * holds a usable unit the pack is the default, as it is for every product today.
 */
export function resolveUnitDefault(view: LadderView, scopes: UnitScopes): OrderUnitDefault {
  const skipped: SkippedScope[] = [];
  for (const scope of SCOPE_ORDER) {
    const value = scopes[scope]?.trim();
    if (!value) continue;
    const ref = refOfValue(view, value);
    if (ref) {
      return {
        orderUnit: ref,
        label: rowOf(view, ref).label,
        anchor: { unit: ref, scope },
        scope,
        skipped,
      };
    }
    skipped.push({ scope, value });
  }
  return {
    orderUnit: "pack",
    label: rowOf(view, "pack").label,
    anchor: { unit: "pack", scope: "fallback" },
    scope: "fallback",
    skipped,
  };
}

export type InvoiceUnitChoice =
  | { mode: "legacy"; scope: UnitScope; skipped: SkippedScope[] }
  | { mode: "ordered"; scope: UnitScope; skipped: SkippedScope[] }
  | { mode: "unit"; unit: UnitRef; label: string; scope: UnitScope; skipped: SkippedScope[] };

/**
 * What an invoice line shows. `legacy` is today's behaviour (the unit sold, today's code); `ordered` is the unit the line
 * was ordered in; any other value is a unit. A name the product lacks falls back to the smallest unit; nothing set anywhere
 * is `legacy`, so a tenant that never chose sees no change (Q5).
 */
export function resolveInvoiceUnit(view: LadderView, scopes: UnitScopes): InvoiceUnitChoice {
  const skipped: SkippedScope[] = [];
  let anySet = false;
  for (const scope of SCOPE_ORDER) {
    const value = scopes[scope]?.trim();
    if (!value) continue;
    anySet = true;
    const word = value.toLowerCase();
    if (word === "legacy" || word === "ordered") return { mode: word, scope, skipped };
    const ref = refOfValue(view, value);
    if (ref) return { mode: "unit", unit: ref, label: rowOf(view, ref).label, scope, skipped };
    skipped.push({ scope, value });
  }
  if (!anySet) return { mode: "legacy", scope: "fallback", skipped };
  const unit = smallestRef(view);
  return { mode: "unit", unit, label: rowOf(view, unit).label, scope: "fallback", skipped };
}
