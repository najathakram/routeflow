import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-1099 §6 (WP5, R22): "stop selling what they have". A SELF-SERVE enable of an add-on that would add nothing is
 * refused, so a workspace is never charged for a flag it already holds.
 *
 * The rule, in one place (the enable call, the proration preview and the sweep script all read it):
 *  - the SKU must grant at least one flag (`grantsFlags` non-empty). "Every flag is already effective" is true of an
 *    empty list, so an empty list is never a reason to refuse;
 *  - a capacity SKU (a meter key or a per-unit capacity) is exempt: more of it is always something new;
 *  - otherwise the SKU adds nothing when EVERY flag it grants is already effective for the workspace.
 *
 * The caller passes the resolver's per-key verdict and only for a workspace that does NOT hold the SKU's own row
 * (an active row is the idempotent repeat / buy-more path and is left exactly as it was), so "effective" here can only
 * come from somewhere other than this SKU. A flag the resolver does not know is NOT effective: the sale goes ahead as
 * it always has, never a refusal on a guess.
 */
export interface AddonGrantShape {
  sku: string;
  name: string;
  grantsFlags?: readonly string[] | null;
  meteredKey?: string | null;
  capacityPerUnit?: number | null;
}

/** The resolver's verdict for a key: only `effective` matters here. */
export type EffectiveByKey = ReadonlyMap<string, { effective: boolean }>;

export function isCapacityAddon(def: Pick<AddonGrantShape, "meteredKey" | "capacityPerUnit">) {
  return def.meteredKey != null || def.capacityPerUnit != null;
}

/** True when buying `def` would give the workspace something it does not already have. */
export function skuAddsSomething(def: AddonGrantShape, effective: EffectiveByKey): boolean {
  const flags = def.grantsFlags ?? [];
  if (flags.length === 0) return true;
  if (isCapacityAddon(def)) return true;
  return flags.some((flag) => effective.get(flag)?.effective !== true);
}

/** The fixed refusal (a 409 body and the preview's `refusal`): fixed copy, never the catalog's or a flag's text. */
export function addonAlreadyIncludedRefusal(addonName: string) {
  return {
    code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
    message: `You already have ${addonName}, so there is nothing to buy.`,
  };
}
