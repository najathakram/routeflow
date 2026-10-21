/**
 * Row 640 (SA-834): the ONE verdict on a GRANT override a snapshot restore is about to re-create.
 * `planGuarded` calls it for preview AND apply, so the two can never disagree.
 *
 *  - a COMP GRANT is restored AS-WAS (an admin's deliberate comp; the 09-18 ruling is "restore as
 *    configured"). Its only hold is an unmet registry `requires` (the B524 rule);
 *  - a NON-COMP GRANT on a billable add-on-keyed key (one with catalog SKUs) is held ADDON_NOT_PAID
 *    unless the key is COVERED at restore time: (a) an ACTIVE `TenantAddon` row for the key's SKU that
 *    passes `isStripeBillableAddonRow` (the exact billed-row predicate, never `isPayingRow`), or (b) the
 *    tenant's plan version includes that SKU (`includedAt`, the inclusion resolver), or (c) the same
 *    transaction activates the add-on (a checkout's pending key, paid in that checkout). NEVER
 *    `planAllows`: it treats every add-on-keyed key as allowed, which is the bug itself;
 *  - non-add-on keys are only requires-checked; a DENY is never judged.
 *
 * `requires` is judged over the keys effective AFTER the restore (the same `checkFeatureRequires` the
 * override-create path uses): GRANT overrides (current + this restore's own), minus DENYs; an add-on
 * key by its active row (or a pending one); any other key by what the plan allows.
 */
import type { Prisma } from "@prisma/client";
import type { ConfigSnapshotSkipReason } from "@routeflow/types";
import { includedAtPlanVerdict } from "./addon-catalog-invalid";
import { isStripeBillableAddonRow } from "./addon-row";
import {
  ADDON_KEY_TO_REGISTRY_KEY,
  checkFeatureRequires,
  featureDefByKey,
} from "./feature-registry";
import type { SnapshotOverrideEntry } from "./tenant-config-snapshot";

/** What the transition service knows about the tenant's catalog (its plan version), by SKU. */
export interface AddonCoverage {
  /** The catalog monthly price of `sku` in the tenant's plan version, or null when it does not list it. */
  priceOf(sku: string): number | null;
  /** Is `sku` bundled at the tenant's plan (the inclusion resolver's INCLUDED verdict)? */
  includedAt(sku: string): boolean;
}

/** `planAllows` as the plan-change wiring builds it: a predicate that also carries the catalog coverage. */
export type RestorePlanAllows = ((featureKey: string) => boolean) & { coverage?: AddonCoverage };

export interface AddonRowForVerdict {
  addonKey: string;
  sku?: string | null;
  active?: boolean | null;
  isComp?: boolean | null;
  priceSnapshot?: unknown;
}

export interface OverrideVerdictContext {
  planAllows?: RestorePlanAllows;
  /** Add-on keys the SAME transaction activates after the restore (paid in that checkout). */
  pendingAddonKeys: readonly string[];
  /** Override effects in force after the restore (current active + this restore's own creates). */
  effects: readonly (readonly [string, "GRANT" | "DENY"])[];
  /** Lazily loaded, shared with the fleet guard: the tenant's ACTIVE add-on rows. */
  loadAddonRows: () => Promise<readonly AddonRowForVerdict[]>;
}

export type OverrideHoldReason = Extract<
  ConfigSnapshotSkipReason,
  "ADDON_NOT_PAID" | "REQUIRES_UNMET"
>;

const registryKeyOf = (addonKey: string): string => ADDON_KEY_TO_REGISTRY_KEY[addonKey] ?? addonKey;
const isAddonKeyed = (key: string): boolean => {
  const via = featureDefByKey(key)?.gate.via;
  return via === "RequireAddon" || via === "guard";
};

export async function overrideRestoreVerdict(
  _tx: Prisma.TransactionClient,
  _tenantId: string,
  override: SnapshotOverrideEntry,
  ctx: OverrideVerdictContext,
): Promise<OverrideHoldReason | null> {
  if (override.effect !== "GRANT") return null;
  const def = featureDefByKey(override.featureKey);
  if (!def) return null;

  const rows =
    def.requires || (def.billing.skus.length > 0 && override.kind !== "COMP")
      ? await ctx.loadAddonRows()
      : [];

  if (def.requires) {
    const effective = new Set<string>();
    const decided = new Map<string, "GRANT" | "DENY">(ctx.effects);
    const allows = ctx.planAllows ?? (() => true);
    const hasRow = (k: string) =>
      rows.some((r) => registryKeyOf(r.addonKey) === k && r.active !== false) ||
      ctx.pendingAddonKeys.some((p) => registryKeyOf(p) === k);
    const wanted = [...(def.requires.allOf ?? []), ...(def.requires.anyOf ?? [])];
    for (const k of wanted) {
      const d = decided.get(k);
      if (d === "GRANT") effective.add(k);
      else if (d === "DENY") continue;
      else if (isAddonKeyed(k) ? hasRow(k) : allows(k)) effective.add(k);
    }
    if (!checkFeatureRequires(def.requires, effective).satisfied) return "REQUIRES_UNMET";
  }

  if (
    override.kind !== "COMP" &&
    isAddonKeyed(override.featureKey) &&
    def.billing.skus.length > 0
  ) {
    const coverage = ctx.planAllows?.coverage;
    const skus = def.billing.skus;
    if (ctx.pendingAddonKeys.some((p) => registryKeyOf(p) === override.featureKey)) return null;
    const billed = rows.some((r) => {
      if (registryKeyOf(r.addonKey) !== override.featureKey) return false;
      const sku = r.sku ?? skus[0];
      return isStripeBillableAddonRow({ ...r, sku }, coverage?.priceOf(sku) ?? null);
    });
    if (billed) return null;
    if (skus.some((sku) => coverage?.includedAt(sku))) return null;
    return "ADDON_NOT_PAID";
  }
  return null;
}

/** The catalog coverage of one plan version, for a plan key (the SKU's `includedAtPlan` verdict). */
export function coverageOf(
  addonSkus: readonly {
    sku: string;
    monthlyPrice: unknown;
    includedAtPlan?: string | null;
  }[],
  planKey: string,
): AddonCoverage {
  return {
    priceOf: (sku) => {
      const def = addonSkus.find((s) => s.sku === sku);
      return def ? Number(def.monthlyPrice) : null;
    },
    includedAt: (sku) => {
      const def = addonSkus.find((s) => s.sku === sku);
      return !!def && includedAtPlanVerdict(def, planKey).kind === "INCLUDED";
    },
  };
}
