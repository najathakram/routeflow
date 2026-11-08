/**
 * FG-1 WP9a (R19): the ONE builder for the sentence a refused business reads. Every refusal seat calls it
 * (`addon.guard.ts`, `plan-gate.ts`, `products.service.ts`, `inline-returns.service.ts`), so a customer never sees a
 * registry key, an add-on key, an add-on SKU code or a plan key. It builds the MESSAGE only: the wire fields (`code`,
 * `addonKeys`, `flag`, `upgrade`, `state`) are unchanged and clients branch on `code`.
 *
 * The next step comes from the key's grant path, read from its registry row:
 *   - a row an add-on can grant, or an offered SKU  -> "Add it in Billing."
 *   - a plan that includes it (plan-gate, upgrade)  -> "included in the {Plan} plan and higher"
 *   - override-only (no add-on, nothing offered)    -> "Ask RouteFlow to turn it on."
 * `ocr` is override-only for a refused LITE business: it never says "included" (that contradicts the 403 it rides on).
 */
import { FEATURE_REGISTRY, type FeatureDef } from "./feature-registry";
import { LITE_PLAN_DISPLAY_NAME, PLAN_KEYS } from "./plan-catalog.constants";

export interface DenialInput {
  /** The registry key(s) or add-on key(s) the business lacks. */
  keys: readonly string[];
  /** A purchasable SKU is offered for it (the plan gate's `upgrade.addonSku`). */
  addonOffered?: boolean;
  /** The cheapest plan that includes it (the plan gate's `upgrade.planKey`). */
  planKey?: string | null;
}

const GENERIC = "This feature is not available on your current plan.";

function rowFor(key: string): FeatureDef | undefined {
  return (
    FEATURE_REGISTRY.find((f) => f.key === key) ??
    FEATURE_REGISTRY.find((f) => f.grant.addonKey === key)
  );
}

/** A plan's display name ("Scale"); undefined for a key this build does not know (a custom plan). */
export function planDisplayName(planKey: string | null | undefined): string | undefined {
  if (!planKey || !(PLAN_KEYS as readonly string[]).includes(planKey)) return undefined;
  if (planKey === "LITE") return LITE_PLAN_DISPLAY_NAME;
  return planKey.charAt(0) + planKey.slice(1).toLowerCase();
}

export function denialText(input: DenialInput): string {
  const rows = [...new Set(input.keys.map(rowFor).filter((r): r is FeatureDef => Boolean(r)))];
  const names = rows.map((r) => r.label);
  if (names.length === 0) {
    const plan = planDisplayName(input.planKey);
    if (input.addonOffered) return "This feature is an add-on. Add it in Billing.";
    if (plan) return `This feature is included in the ${plan} plan and higher.`;
    return input.keys.length > 0
      ? "This feature isn't turned on for your account. Ask RouteFlow."
      : GENERIC;
  }
  const joined = names.join(" or ");
  const single = names.length === 1;
  if (input.addonOffered || rows.some((r) => r.grant.addonKey)) {
    return single
      ? `${joined} is an add-on. Add it in Billing.`
      : `You need one of these add-ons: ${joined}. Add one in Billing.`;
  }
  const plan = planDisplayName(input.planKey);
  if (plan) return `${joined} is included in the ${plan} plan and higher.`;
  return single
    ? `${joined} isn't turned on for your account. Ask RouteFlow to turn it on.`
    : `One of these needs to be turned on for your account: ${joined}. Ask RouteFlow to turn it on.`;
}
