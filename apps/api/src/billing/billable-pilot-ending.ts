import { isAlwaysEnforcedPlan } from "./plan-catalog.constants";
import { PAYING_TENANT_CONDITIONS } from "./mrr.service";
import { includedAtPlanVerdict } from "./addon-catalog-invalid";
import { ADDON_KEY_TO_REGISTRY_KEY, featureDefByKey } from "./feature-registry";
import { servedAnswer } from "./served-answer";

/** R25: the owner is told this long before a billable free period ends. */
export const PILOT_WARNING_DAYS = 7;

/** The override kinds that are a FREE PERIOD (SA-1100 §1 rule 1). Every other kind is a comp, support grant or grandfather. */
export const FREE_PERIOD_KINDS: readonly string[] = ["PILOT", "TRIAL"];

/**
 * SA-1100 §1: a pilot ending is "billable" only when ALL FIVE hold. This is the ONE predicate; the nightly job
 * (`warnBillablePilotsEnding`) and its spec both import it, and nothing else re-derives any part of it.
 *
 *  1. The override is a free period (PILOT or TRIAL), a GRANT, not revoked, and ends in (now, now + 7 days].
 *  2. Ending it CHANGES THE SERVED ANSWER: the served-answer function the sweep's `old` column uses
 *     (`servedAnswer`), evaluated WITHOUT this row, says false. A key that a courtesy allow still serves
 *     (a dark flag while enforcement is off) loses nothing, and a key no guard checks (gate via none) has no
 *     answer to lose.
 *  3. No active add-on row (paid or comp) holds the SKU, and the plan does not include it.
 *  4. The SKU is in the tenant's pinned catalog, priced above 0, and flat (`meteredKey` null): a capacity
 *     SKU's cost depends on how many are needed, so it is out (LATER: add it when a capacity pilot is granted).
 *  5. The business is an ACTIVE PRODUCTION-class tenant and not deleted, the same rule as
 *     `PAYING_TENANT_CONDITIONS` (a test or demo pilot never mails the owner).
 *
 * A GRANT override never creates a `TenantAddon` row, so nothing is billed when it ends: the business LOSES the
 * feature. That is what the owner mail says (SA-1100 §1); it must never claim a paid add-on starts by itself.
 *
 * The credit check has its own served rule (`creditLimitCheckApplies`), but it has no SKU, so rule 4 keeps it
 * out; a spec pins that, so a future SKU on it fails loudly instead of being read as a plan flag.
 */
export interface BillablePilotFacts {
  override: {
    featureKey: string;
    kind: string;
    effect: string;
    revokedAt: Date | null;
    expiresAt: Date | null;
  };
  now: Date;
  tenant: { status: string; class: string; deletedAt: Date | null };
  /** The plan key the catalog inclusion is judged at (subscription plan, else the tenant plan). */
  planKey: string;
  /** The plan's entitlements; null when they could not be resolved (never billable: fail closed). */
  ent: { planKey: string; flags: readonly string[] } | null;
  /** The OTHER active overrides of this business (this row excluded), keyed by feature key. */
  otherOverrides: ReadonlyMap<string, "GRANT" | "DENY">;
  /** The business's add-on rows. */
  addonRows: ReadonlyArray<{ addonKey: string; sku: string | null; active: boolean }>;
  /** The add-on SKUs of the business's pinned catalog version. */
  catalogSkus: ReadonlyArray<{
    sku: string;
    name: string;
    monthlyPrice: unknown;
    meteredKey: unknown;
    includedAtPlan?: string | null;
  }>;
}

export interface BillablePilotSku {
  sku: string;
  name: string;
  monthlyPrice: number;
}

export function billablePilotEnding(
  f: BillablePilotFacts,
  env = process.env,
): BillablePilotSku | null {
  const { override, now } = f;

  // 1. a free period that is still live and ends within the warning window
  if (!FREE_PERIOD_KINDS.includes(override.kind) || override.effect !== "GRANT") return null;
  if (override.revokedAt !== null || override.expiresAt === null) return null;
  const horizon = now.getTime() + PILOT_WARNING_DAYS * 24 * 60 * 60 * 1000;
  if (override.expiresAt.getTime() <= now.getTime() || override.expiresAt.getTime() > horizon) {
    return null;
  }

  // 5. a real, live, production business
  if (f.tenant.status !== PAYING_TENANT_CONDITIONS.status) return null;
  if (f.tenant.class !== PAYING_TENANT_CONDITIONS.class) return null;
  if (f.tenant.deletedAt != PAYING_TENANT_CONDITIONS.deletedAt) return null;

  const feature = featureDefByKey(override.featureKey);
  if (!feature || feature.gate.via === "none") return null;

  // 4. a flat, paid SKU of this feature in the pinned catalog that the plan does not include
  const sku = f.catalogSkus.find(
    (s) =>
      feature.billing.skus.includes(s.sku) &&
      Number(s.monthlyPrice) > 0 &&
      (s.meteredKey ?? null) === null &&
      includedAtPlanVerdict(s, f.planKey).kind === "NOT_INCLUDED",
  );
  if (!sku) return null;

  // 3. no active add-on row (paid or comp) holds the SKU or the feature
  const holds = f.addonRows.some(
    (r) =>
      r.active &&
      (r.sku === sku.sku ||
        r.addonKey === override.featureKey ||
        ADDON_KEY_TO_REGISTRY_KEY[r.addonKey] === override.featureKey),
  );
  if (holds) return null;

  // 2. ending it must change the served answer: without this row, the guards say no
  if (!f.ent) return null;
  const stillServed = servedAnswer(
    feature,
    {
      ent: f.ent,
      overrides: f.otherOverrides,
      activeAddonKeys: new Set(f.addonRows.filter((r) => r.active).map((r) => r.addonKey)),
      isAlwaysEnforced: isAlwaysEnforcedPlan(f.ent.planKey),
    },
    env,
  );
  if (stillServed) return null;

  return { sku: sku.sku, name: sku.name, monthlyPrice: Number(sku.monthlyPrice) };
}
