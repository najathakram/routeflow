/**
 * Row 640 (SA-834): the ONE verdict on a GRANT override a snapshot restore is about to re-create.
 * `planGuarded` calls it for preview AND apply, so the two can never disagree.
 *
 *  - a COMP GRANT is restored AS-WAS (an admin's deliberate comp; the 09-18 ruling is "restore as
 *    configured"). Its only hold is an unmet registry `requires` (the B524 rule);
 *  - a NON-COMP GRANT on a billable add-on-keyed key (one with catalog SKUs) is held ADDON_NOT_PAID
 *    unless the key is COVERED at restore time: (a) an ACTIVE `TenantAddon` row for the key's SKU that
 *    passes `isStripeBillableAddonRow` (the exact billed-row predicate, never `isPayingRow`), or (b) the
 *    tenant's plan version includes that SKU (`includedAt`, the inclusion resolver). A PENDING key (an
 *    add-on the same transaction activates) does NOT cover payment: its row may be a trial row at price
 *    0, so the grant is held and "Restore now" judges it once the row exists. NEVER
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
import { addonCodeOf, isStripeBillableAddonRow } from "./addon-row";
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
  /** The plan's OWN feature flags, apart from any a SKU grants (a tenant holds a SKU's flags only with the SKU). */
  planFlags: ReadonlySet<string>;
  /** The plan flags `sku` grants to a tenant on any plan (`grantsFlags`). */
  grantsFlagsOf(sku: string): readonly string[];
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
  /** Add-on codes the SAME transaction activates after the restore: they count for `requires`, never for payment. */
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
  // A key the registry no longer has gets NO verdict (null = neither held nor covered). This is the
  // right answer and normally unreachable: `planRestore` already moves an unknown feature to `skipped`
  // (UNKNOWN_FEATURE) before this runs, so it never reaches `overrides.create`. Holding it here would
  // only mislabel it ADDON_NOT_PAID / REQUIRES_UNMET and keep the snapshot claimable forever.
  if (!def) return null;

  const rows =
    def.requires || (def.billing.skus.length > 0 && override.kind !== "COMP")
      ? await ctx.loadAddonRows()
      : [];

  if (def.requires) {
    const effective = new Set<string>();
    const decided = new Map<string, "GRANT" | "DENY">(ctx.effects);
    const allows = ctx.planAllows ?? (() => true);
    const coverage = ctx.planAllows?.coverage;
    // Pending keys are SKU codes ("OCR_PACK_250") or legacy add-on keys; either names its registry key.
    const pendingNames = (k: string) =>
      ctx.pendingAddonKeys.some(
        (p) =>
          p === k || registryKeyOf(p) === k || (featureDefByKey(k)?.billing.skus ?? []).includes(p),
      );
    // `requires` counts a pending key (the feature is on while its row exists); PAYMENT does not (below).
    const hasRow = (k: string) =>
      rows.some((r) => registryKeyOf(r.addonKey) === k && r.active !== false) || pendingNames(k);
    // Flags the tenant holds AFTER the restore: the plan's own, plus what its ACTIVE (or same-transaction
    // pending) add-on SKUs grant - never every SKU in the version (that is what `planAllows` over-counts).
    const heldFlags = new Set<string>(coverage?.planFlags ?? []);
    if (coverage) {
      for (const r of rows) {
        if (r.active === false) continue;
        for (const f of coverage.grantsFlagsOf(r.sku ?? addonCodeOf(r.addonKey))) heldFlags.add(f);
      }
      for (const p of ctx.pendingAddonKeys)
        for (const f of coverage.grantsFlagsOf(addonCodeOf(p))) heldFlags.add(f);
    }
    const flagHeld = (k: string): boolean => {
      if (!coverage) return allows(k);
      const key = featureDefByKey(k);
      return (
        heldFlags.has(k) ||
        (key?.billing.catalogFlag !== undefined && heldFlags.has(key.billing.catalogFlag)) ||
        key?.defaultGranted === true
      );
    };
    const wanted = [...(def.requires.allOf ?? []), ...(def.requires.anyOf ?? [])];
    for (const k of wanted) {
      const d = decided.get(k);
      if (d === "GRANT") effective.add(k);
      else if (d === "DENY") continue;
      else if (isAddonKeyed(k) ? hasRow(k) : flagHeld(k)) effective.add(k);
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
    // A PENDING key never covers payment: `pendingAddonKeys` is the plan-change payload's add-on codes, and
    // the row the checkout writes can be a trial row at price 0 / unbilled (subscription-mutation.service.ts,
    // "price 0 and unbilled, until that checkout"). Its price is not known at hook time, so the grant is held
    // (the snapshot stays claimable) and "Restore now" judges it once the row exists and is billed.
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

/**
 * The catalog coverage for one restore: inclusion and granted flags are the TARGET version's
 * (`addonSkus`); a SKU's price comes from `priceBySku`, which the caller builds with `pricedAddonSku`
 * (the tenant's pinned version, else the published one) so a pin that predates a SKU still prices it.
 */
export function coverageOf(
  input: {
    addonSkus: readonly {
      sku: string;
      monthlyPrice: unknown;
      includedAtPlan?: string | null;
      grantsFlags?: readonly string[] | null;
    }[];
    planFlags: Iterable<string>;
    priceBySku: ReadonlyMap<string, number>;
  },
  planKey: string,
): AddonCoverage {
  const { addonSkus, priceBySku } = input;
  const planFlags = new Set(input.planFlags);
  return {
    priceOf: (sku) => priceBySku.get(sku) ?? null,
    includedAt: (sku) => {
      const def = addonSkus.find((s) => s.sku === sku);
      return !!def && includedAtPlanVerdict(def, planKey).kind === "INCLUDED";
    },
    planFlags,
    grantsFlagsOf: (sku) => addonSkus.find((s) => s.sku === sku)?.grantsFlags ?? [],
  };
}
