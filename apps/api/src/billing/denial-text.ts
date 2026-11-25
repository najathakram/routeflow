/**
 * FG-1 WP9a (R19): the ONE builder for the sentence a refused business reads. Every refusal seat calls it
 * (`addon.guard.ts`, `plan-gate.ts`, `products.service.ts`, `inline-returns.service.ts`), so a customer never sees a
 * registry key, an add-on key, an add-on SKU code or a plan key. It builds the MESSAGE only: the wire fields (`code`,
 * `addonKeys`, `flag`, `upgrade`, `state`) are unchanged and clients branch on `code`.
 *
 * The next step comes from the key's grant path, read from its registry row:
 *   - an add-on the business can buy itself (a SELF-SERVICE SKU, `isSelfServiceAddon`) -> "add it in Billing."
 *   - a plan that includes it (plan gate, upgrade)                                    -> "Included with the {Plan} plan"
 *   - everything else (override-only, or an add-on only RouteFlow can turn on)          -> "ask RouteFlow."
 * When the plan gate passes `addonSku: null` (a DENY override, a failed catalog read) no add-on is offered, so the
 * row's own SKU is ignored.
 * Billing lists only the self-serve SKUs, so pointing there for any other add-on would be a dead end. `ocr` is
 * override-only for a refused LITE business: it never says "comes with" (that contradicts the 403 it rides on).
 */
import { planDisplayName as sharedPlanDisplayName } from "@routeflow/pricing";
import { FEATURE_REGISTRY, type FeatureDef } from "./feature-registry";
import {
  FLAG_TO_ADDON_SKU,
  LEGACY_ADDON_KEY_TO_SKU,
  isSelfServiceAddon,
} from "./plan-catalog.constants";

export interface DenialInput {
  /** The registry key(s) or add-on key(s) the business lacks. */
  keys: readonly string[];
  /** The SKU offered for it (the plan gate's `upgrade.addonSku`); only a self-serve SKU counts as offered. */
  addonSku?: string | null;
  /** The cheapest plan that includes it (the plan gate's `upgrade.planKey`). */
  planKey?: string | null;
}

const GENERIC = "This feature isn't available on your plan.";
/** The sentence for a key this build does not know; the add-on guard's internal-only fallback reads it too. */
export const UNKNOWN_FEATURE_TEXT =
  "This feature isn't turned on for your account. Ask RouteFlow to turn it on.";

/** Plain names where the registry label is back-office wording (the registry stays the one source of the rest). */
const PLAIN_NAME: Readonly<Record<string, string>> = { ocr: "Bill scanning" };

function rowFor(key: string): FeatureDef | undefined {
  return (
    FEATURE_REGISTRY.find((f) => f.key === key) ??
    FEATURE_REGISTRY.find((f) => f.grant.addonKey === key)
  );
}

/** The row can be bought by the business itself in Billing: its SKU is a self-serve one. */
function buyableInBilling(row: FeatureDef): boolean {
  const sku =
    FLAG_TO_ADDON_SKU[row.key] ??
    (row.grant.addonKey ? LEGACY_ADDON_KEY_TO_SKU[row.grant.addonKey] : undefined);
  return sku !== undefined && isSelfServiceAddon(sku);
}

/**
 * A plan's display name ("Scale", "Essentials" for CORE); undefined for a key this build does not know
 * (a custom plan). SA-1254 V7 (P-45): the ONE helper is @routeflow/pricing's; this re-export keeps the
 * refusal seats' import path.
 */
export const planDisplayName = sharedPlanDisplayName;

export function denialText(input: DenialInput): string {
  const rows = [...new Set(input.keys.map(rowFor).filter((r): r is FeatureDef => Boolean(r)))];
  const names = rows.map((r) => PLAIN_NAME[r.key] ?? r.label);
  const offered = input.addonSku != null && isSelfServiceAddon(input.addonSku);
  const plan = planDisplayName(input.planKey);
  if (names.length === 0) {
    if (offered) return "This feature is an add-on. Add it in Billing.";
    if (plan) return `This feature is included with the ${plan} plan and higher.`;
    return input.keys.length > 0 ? UNKNOWN_FEATURE_TEXT : GENERIC;
  }
  const joined = names.join(" or ");
  const single = names.length === 1;
  // The plan gate always says whether it offers an add-on (a string, or null for none: a DENY override, a failed
  // catalog read); that answer is authoritative. The add-on guards say nothing, so the row decides.
  const billing = input.addonSku !== undefined ? offered : rows.some(buyableInBilling);
  // Frames whose words never depend on the name, so a plural name ("Estimates") reads as well as a singular one.
  if (billing) {
    return single
      ? `To use ${joined}, add it in Billing.`
      : `To use one of these, add one in Billing: ${joined}.`;
  }
  if (plan) return `Included with the ${plan} plan and higher: ${joined}.`;
  return single
    ? `To use ${joined}, ask RouteFlow to turn this on.`
    : `To use one of these, ask RouteFlow to turn one on: ${joined}.`;
}
