import { applyLadderChange, roundMoney } from "@routeflow/pricing";

export type TierPriceKey = "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
export const TIER_PRICE_KEYS: readonly TierPriceKey[] = [
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
];
type Price = { toString(): string } | string | number | null | undefined;
/** The price fields of the Details form's draft: the list price and tiers 2-5. */
export type PriceDraftKey = "pricePerUnit" | TierPriceKey;
export type TierPrices = { pricePerUnit: Price } & Partial<Record<TierPriceKey, Price>>;

const asDecimal = (v: unknown): string | undefined => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n >= 0 ? String(n) : undefined;
};

/**
 * The tier keys of a product PATCH from the detail page's edit form or its variant modal (product page audit
 * 2026-10-14, money). A tier the operator did not touch (its draft still equals the stored value the form showed, in
 * cents) follows a list-price change through `applyLadderChange("pricePerUnit", …)`, the SAME rule as the products list quick-save; a tier
 * the operator typed always wins. Blank or invalid input is never sent (leave unchanged).
 */
export function editTierPatch(
  stored: TierPrices,
  draft: Partial<Record<"pricePerUnit" | TierPriceKey, string | undefined>>,
): Record<TierPriceKey, string | undefined> {
  const untouched: Partial<Record<TierPriceKey, Price>> = {};
  for (const k of TIER_PRICE_KEYS) {
    const shown = parseFloat(String(stored[k] ?? stored.pricePerUnit ?? ""));
    const typed = parseFloat(String(draft[k] ?? ""));
    if (Number.isFinite(typed) && roundMoney(typed) === roundMoney(shown)) untouched[k] = stored[k];
  }
  // A list change is the Tier 1 case of the ONE ladder rule (#3468): equal-to-old moves, 0 stays, above is capped.
  const moved = applyLadderChange(
    "pricePerUnit",
    stored.pricePerUnit,
    draft.pricePerUnit ?? stored.pricePerUnit,
    untouched,
  );
  const out = {} as Record<TierPriceKey, string | undefined>;
  // Only an UNTOUCHED tier may take a moved value: a typed tier is absent from `untouched` (read there as 0), so its
  // own draft always wins, whatever the old list was (#3470 review).
  for (const k of TIER_PRICE_KEYS)
    out[k] = (k in untouched ? moved[k] : undefined) ?? asDecimal(draft[k]);
  return out;
}

/** The tiers a save of this draft would MOVE with the list (for the "tiers will move" note); {} when none. */
export function editTierPatchMoves(
  stored: TierPrices,
  draft: Partial<Record<"pricePerUnit" | TierPriceKey, string | undefined>>,
): Partial<Record<TierPriceKey, string>> {
  const patch = editTierPatch(stored, draft);
  const moves: Partial<Record<TierPriceKey, string>> = {};
  for (const k of TIER_PRICE_KEYS) {
    const typed = parseFloat(String(draft[k] ?? ""));
    const sent = parseFloat(String(patch[k] ?? ""));
    if (
      Number.isFinite(sent) &&
      (!Number.isFinite(typed) || roundMoney(sent) !== roundMoney(typed))
    )
      moves[k] = patch[k];
  }
  return moves;
}

/** Two money strings are the same price when they match in cents ("10" = "10.00"); anything unparsable compares as text. */
const sameMoney = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined || a.trim() === "" || b.trim() === "") return a === b;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? roundMoney(x) === roundMoney(y) : a === b;
};

type PriceDraft = Partial<Record<PriceDraftKey, string | undefined>>;

/**
 * The price keys of a Details-form or variant-modal save (units v2, money). A price save elsewhere on the page moves
 * prices while the form is open, so the form sends a price ONLY when the operator changed it: a field whose draft still
 * equals what the form was SEEDED with (compared in cents) is left out of the PATCH, never written back as a snapshot.
 * "Untouched" is always draft against seeded, never draft against the refetched product.
 *
 * A changed list price is sent with the tiers the operator typed (always) and ONLY the untouched tiers the ladder rule
 * (`applyLadderChange("pricePerUnit", …)`, the products list quick-save's rule) moves with it. That rule reads the
 * FRESH product (`stored`): a tier that tracks the list now moves from its fresh value, one a v2 save has since pulled
 * away from the list stays out of the PATCH. An untouched, unmoved tier is never sent.
 * Without the seed (no edit session recorded) this falls back to the whole `editTierPatch` (the pre-fix shape).
 */
export function detailsPricePatch(
  stored: TierPrices,
  draft: PriceDraft,
  seeded: Record<PriceDraftKey, string> | undefined,
): Record<PriceDraftKey, string | undefined> {
  if (!seeded)
    return { pricePerUnit: asDecimal(draft.pricePerUnit), ...editTierPatch(stored, draft) };
  const listDirty = !sameMoney(draft.pricePerUnit, seeded.pricePerUnit);
  const untouched: Partial<Record<TierPriceKey, Price>> = {};
  for (const k of TIER_PRICE_KEYS) if (sameMoney(draft[k], seeded[k])) untouched[k] = stored[k];
  const moved = listDirty
    ? applyLadderChange(
        "pricePerUnit",
        stored.pricePerUnit,
        draft.pricePerUnit ?? stored.pricePerUnit,
        untouched,
      )
    : {};
  const out = { pricePerUnit: listDirty ? asDecimal(draft.pricePerUnit) : undefined } as Record<
    PriceDraftKey,
    string | undefined
  >;
  // A tier the operator typed wins; an untouched one is sent only when the ladder moved it.
  for (const k of TIER_PRICE_KEYS) out[k] = k in untouched ? moved[k] : asDecimal(draft[k]);
  return out;
}

/** The tiers a save of this draft would MOVE with the list (the "tiers will move" note): exactly the ones the PATCH carries for them. */
export function detailsPriceMoves(
  stored: TierPrices,
  draft: PriceDraft,
  seeded: Record<PriceDraftKey, string> | undefined,
): Partial<Record<TierPriceKey, string>> {
  if (!seeded) return editTierPatchMoves(stored, draft);
  const patch = detailsPricePatch(stored, draft, seeded);
  const moves: Partial<Record<TierPriceKey, string>> = {};
  for (const k of TIER_PRICE_KEYS)
    if (patch[k] !== undefined && sameMoney(draft[k], seeded[k])) moves[k] = patch[k];
  return moves;
}

/**
 * The tiers `applyLadderChange` should read when an in-form tier edit commits (the cascade into the lower tiers). A
 * tier the operator has not touched (draft equals seeded, in cents) is read from the FRESH product: the draft still
 * holds the value the form opened with, and a price save made meanwhile would otherwise be cascaded from a stale
 * figure and sent as typed. A typed tier is read from the draft. Without the seed it is the draft, as before.
 */
export function cascadeTiers(
  stored: TierPrices,
  draft: PriceDraft,
  seeded: Record<PriceDraftKey, string> | undefined,
): Partial<Record<TierPriceKey, Price>> {
  const out: Partial<Record<TierPriceKey, Price>> = {};
  for (const k of TIER_PRICE_KEYS)
    out[k] = seeded && sameMoney(draft[k], seeded[k]) ? stored[k] : draft[k];
  return out;
}
