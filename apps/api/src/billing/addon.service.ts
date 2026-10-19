import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import {
  LEGACY_ADDON_KEY_TO_SKU,
  addonSkuCode,
  normalizePlanKey,
  planKeyFromEnum,
} from "./plan-catalog.constants";
import { inclusionOf } from "./addon-inclusion";
import { inclusionCatalogFor } from "./plan-version-pin";
import { updateAddonRowTx, upsertAddonRowTx, type AddonChangeSource } from "./tenant-addon-writer";
import { addonCatalogInvalidException } from "./addon-catalog-invalid";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import {
  ADDON_KEY_TO_REGISTRY_KEY,
  DEFAULT_GRANTED_ADDON_FEATURES,
  defaultGrantRequirementKeys,
  isDefaultGrantedAddon,
} from "./feature-registry";
import { FeatureOverrideService } from "./feature-override.service";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { BillingEventService } from "./billing-event.service";
import { emitAddonDelta, lockTenantForLedger } from "./addon-ledger";
import { addonCodeOf, findAddonRow } from "./addon-row";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { roundMoney } from "@routeflow/pricing";

/**
 * A Stripe `resource_missing` / 404 error means the item we tried to act on is
 * already gone (e.g. a deleted subscription item) — treat that ONE case as a
 * no-op success. Every other Stripe failure must be surfaced to the caller
 * (B107): never widen this predicate.
 */
export function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | undefined;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

/** SA-693: the explicit comp choice of an admin enable (see `enableAddon`). */
export interface EnableAddonOptions {
  /** Grant free on purpose: isComp true, price 0, no Stripe item, nothing booked. */
  comp?: boolean;
  /** Internal: `uncompAddon`'s billed branch re-enters here to bill an active comp row. */
  uncomp?: boolean;
  /**
   * SA-769: the CALLER already holds this add-on's advisory key (`addon:<tenant>:<sku>`), so the enable runs
   * without taking it again. Business-profile confirm holds every profile module's key on one pinned
   * connection (`withConfirmLock`); a second take on this call's own connection would wait on a key its caller
   * holds, time out and 503 the whole apply. Honoured for a COMP enable only (it makes no Stripe write): a
   * billed enable always takes its own lock.
   */
  lockHeld?: boolean;
  /** SA-769: who and why, for the log line only. The audit row is the caller's (ADDON_COMPED). */
  actorId?: string;
  reason?: string;
}

/**
 * Manages add-on features for tenants.
 *
 * Each add-on is a key-value pair (e.g. "ai_scanning", "advanced_routes")
 * that can be toggled on/off per tenant. When Stripe is configured, enabling
 * an add-on also creates a Stripe subscription item for billing.
 *
 * Entitlement and billing must move together: `enableAddon`/`disableAddon` never
 * activate or deactivate an add-on that has a Stripe price attached unless the
 * matching Stripe write actually succeeded (or the Stripe side is already gone —
 * see `isStripeResourceMissing`). A Stripe failure refuses the whole call instead
 * of logging and continuing, so a tenant is never billed for something disabled
 * only in our database, or granted something never billed in Stripe (B107).
 */
/** SA-693: how an uncomp ended up billing the row, reported back so the audit row records what ACTUALLY happened. */
export const UncompBilling = {
  /** A Stripe subscription item now bills it. */
  STRIPE: "STRIPE",
  /** A manually-invoiced tenant: priced and booked, the owner invoices it by hand (notice raised). */
  MANUAL: "MANUAL",
  /** Only the flag flipped: still unbilled at 0 (no Stripe subscription, not manually invoiced). */
  UNBILLED: "UNBILLED",
} as const;
export type UncompBillingMode = (typeof UncompBilling)[keyof typeof UncompBilling];

@Injectable()
export class AddonService {
  private readonly logger = new Logger(AddonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
    private readonly featureResolver: FeatureResolverService,
    private readonly authority: EntitlementAuthority,
    private readonly events: BillingEventService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  // ─── Check access ─────────────────────────────────────────────────────────

  /**
   * Check if a tenant has a specific add-on enabled.
   * Use this in API endpoints to gate premium features.
   *
   * @example
   *   if (!await this.addonService.hasAddon(tenantId, 'ai_scanning')) {
   *     throw new ForbiddenException('AI scanning requires the ai_scanning add-on');
   *   }
   */
  async hasAddon(tenantId: string, addonKey: string): Promise<boolean> {
    // #2188 / SA-385: resolves the add-on whichever way it was keyed (legacy key or SKU).
    const addon = await findAddonRow(this.prisma, tenantId, addonCodeOf(addonKey));
    // Any key that is not default-granted is decided by its row alone, exactly as before.
    if (!DEFAULT_GRANTED_ADDON_FEATURES.some((f) => f.key === addonKey)) {
      return addon?.active === true;
    }
    // Owner ruling 2026-09-28 / SA-540: effective = (preset ∪ default ∪ grants) − denies, in
    // AddonGuard's own order, so a service-level check (InlineReturnsService.assertGranted) never
    // disagrees with the guard in front of it: an override is absolute, then a held row, then
    // the default rule (isDefaultGrantedAddon).
    const override = await this.featureOverrides.get(tenantId, addonKey);
    if (override === "DENY") return false;
    if (override === "GRANT" || addon?.active === true) return true;
    const rowKeys = await this.activeRowKeys(tenantId);
    return (await this.defaultGrantedKeys(tenantId, rowKeys, [addonKey])).includes(addonKey);
  }

  /**
   * Get all active add-ons for a tenant: its active TenantAddon rows plus every default-granted
   * key it qualifies for (owner ruling 2026-09-28 / SA-540, `isDefaultGrantedAddon`). This is what
   * AddonGuard and GET /tenants/me/addons read, so both see the default grant the same way.
   * `onlyKeys` (AddonGuard passes its route's keys) limits the DEFAULT-grant work to those keys:
   * a route gated on some other add-on never pays for it. Rows are always returned in full.
   */
  async getActiveAddons(
    tenantId: string,
    opts?: { onlyKeys?: readonly string[] },
  ): Promise<string[]> {
    const rowKeys = await this.activeRowKeys(tenantId);
    const defaults = await this.defaultGrantedKeys(tenantId, rowKeys, opts?.onlyKeys);
    return defaults.length === 0 ? rowKeys : [...rowKeys, ...defaults];
  }

  private async activeRowKeys(tenantId: string): Promise<string[]> {
    const addons = await this.prisma.tenantAddon.findMany({
      where: { tenantId, active: true },
      select: { addonKey: true },
    });
    return addons.map((a) => a.addonKey);
  }

  /** Last fail-closed warn per tenant — the default-grant path runs on polled guard routes. */
  private readonly defaultGrantWarnedAt = new Map<string, number>();

  /**
   * The default-granted add-on keys `tenantId` holds with no row: registry `defaultGranted`, no
   * DENY override on the key, and `requires` met against its requirement set (rows ∪ ent.flags,
   * with GRANT/DENY overrides applied — SA-540: a DENY on flag.returns removes inline returns
   * too). If ENTITLEMENTS cannot be resolved it fails CLOSED (returns []), so that outage never
   * widens access and a held row is never affected. Overrides follow the house contract instead:
   * FeatureOverrideService fails open to an empty map on a DB error (as AddonGuard's own read
   * does), so during an override-table outage a DENY is not seen here either.
   */
  private async defaultGrantedKeys(
    tenantId: string,
    rowKeys: string[],
    onlyKeys?: readonly string[],
  ): Promise<string[]> {
    const rows = new Set(rowKeys);
    const pending = DEFAULT_GRANTED_ADDON_FEATURES.filter(
      (f) => !rows.has(f.key) && (!onlyKeys || onlyKeys.includes(f.key)),
    );
    if (pending.length === 0) return [];
    try {
      const [ent, overrides] = await Promise.all([
        this.entitlements.resolve(tenantId),
        this.featureOverrides.getMany(tenantId, [
          ...pending.map((f) => f.key),
          ...defaultGrantRequirementKeys(pending),
        ]),
      ]);
      return pending
        .filter(
          (f) =>
            overrides.get(f.key) !== "DENY" && isDefaultGrantedAddon(f, rows, ent.flags, overrides),
        )
        .map((f) => f.key);
    } catch (err) {
      const now = Date.now();
      if (now - (this.defaultGrantWarnedAt.get(tenantId) ?? 0) > 60_000) {
        // Bounded (lead nit n2): the throttle only needs recent tenants.
        if (this.defaultGrantWarnedAt.size >= 1_000) this.defaultGrantWarnedAt.clear();
        this.defaultGrantWarnedAt.set(tenantId, now);
        this.logger.warn(
          `default-granted add-ons skipped for tenant ${tenantId} (fail closed): ` +
            `${(err as Error)?.message ?? err}`,
        );
      }
      return [];
    }
  }

  /**
   * Get all add-ons for a tenant (including inactive ones).
   */
  async listAddons(tenantId: string) {
    return this.prisma.tenantAddon.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
  }

  // ─── Manage add-ons ───────────────────────────────────────────────────────

  /**
   * Enable an add-on for a tenant.
   * If Stripe is configured and a stripePriceId is provided, the tenant MUST
   * already have an active Stripe subscription and the Stripe subscription-item
   * create MUST succeed — otherwise the call is refused and no row is written.
   * With no stripePriceId (free-grant path) Stripe is never touched.
   *
   * B524: refuses to grant a key whose registry `requires` (allOf/anyOf) isn't satisfied
   * for this tenant, unless `acknowledgeUnmetRequires` is explicitly true — the server twin
   * of the console's own warn-and-confirm checkbox (#899), read straight off the SAME
   * FEATURE_REGISTRY declaration so the two can't drift. The actual check is
   * `EntitlementAuthority.assertFeatureRequiresMet` — shared with
   * `PlatformAdminController#createFeatureOverride`'s identical guard, see that method's doc
   * for why it lives there and not here or in a service both would need to depend on. A
   * legacy addonKey with no registry row (or a registered row with no `requires`) is a no-op
   * passthrough. `ADDON_KEY_TO_REGISTRY_KEY` translates the addonKey namespace into the
   * registry-key namespace first (B524 fix round, finding F2) — they diverge for the two
   * `RequirePlanFlag`-bridged legacy keys (`msrp`→`flag.msrp`, `sales_agents`→
   * `flag.sales_agents`); an addonKey with no entry there is passed through unchanged (every
   * bare `RequireAddon` row's registry key already equals its addonKey). This is a read-only
   * check, done before the lock below — not part of the Stripe/upsert race (same reasoning as
   * the tenant-existence check above it: a human admin re-checking a prerequisite that changed
   * seconds ago is not worth serialising over).
   *
   * B342: the existing-addon check, the Stripe subscription-item create, and the row
   * upsert below are a check-then-act sequence — without serialisation, two concurrent
   * calls for the same (tenantId, addonKey) can both pass the "already active" guard,
   * both create a live Stripe subscription item, and race the final upsert down to ONE
   * surviving `stripeItemId` pointer (double billing with a single handle to stop it).
   * The whole window is wrapped in `withAdvisoryLock` below, on its own dedicated
   * `"billing"` lock family (`common/db-locks.ts`) — the same cross-replica advisory-lock
   * primitive `order-merge` uses to serialise customer-order merges, but its own pool so
   * billing traffic can never contend with (or be starved by) the order-merge or cron
   * pools. The loser observes the winner's committed row and takes the
   * `ConflictException` path instead of ever touching Stripe. Never add a second,
   * in-process lock on top of this.
   */
  async enableAddon(
    tenantId: string,
    addonKey: string,
    stripePriceId?: string,
    acknowledgeUnmetRequires?: boolean,
    opts?: EnableAddonOptions,
  ) {
    // SA-693: `comp` is an EXPLICIT choice, never derived from "no Stripe item". A comp is granted free
    // on purpose: no Stripe item even on a subscribed tenant (a price id that rides along is ignored),
    // price 0, nothing booked. `uncomp` is the internal re-entry of `uncompAddon`'s billed branch: it
    // may re-activate (bill) a row that is currently an ACTIVE comp, which a plain enable refuses.
    const comp = opts?.comp === true;
    const uncomp = opts?.uncomp === true;
    if (comp) stripePriceId = undefined;
    // Check tenant exists — not part of the race (immutable for this call), so it stays
    // outside the lock.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, plan: true, planVersionId: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    // B524 — see the method doc above for the full rationale.
    await this.authority.assertFeatureRequiresMet(
      tenantId,
      ADDON_KEY_TO_REGISTRY_KEY[addonKey] ?? addonKey,
      acknowledgeUnmetRequires,
    );

    // Dedicated "billing" lock family (`common/db-locks.ts`'s `LOCK_FAMILIES`) — its own
    // pool, sized for this call's own peak (max 4: a short, request-path critical section
    // like order-merge's, but a far rarer settings action than a checkout merge). The
    // "addon:"-prefixed key can never collide with another billing-family key.
    //
    // FINDING-3 (round 3 review): the key is built from the SKU, not the raw addonKey, so this
    // admin path and the tenant self-serve path in subscription-mutation.service.ts (which only
    // ever deals in SKUs) serialise against EACH OTHER. Keyed on the raw addonKey, the four
    // LEGACY_ADDON_KEY_TO_SKU-bridged add-ons took two different locks for the same underlying
    // entitlement — admin on "tobacco_dealer", tenant on "REGULATED_ITEMS" — so the two paths
    // raced despite both holding a lock. An unbridged key has no tenant-path equivalent and
    // keys on itself.
    const lockSku = addonCodeOf(addonKey);
    const lockKey = `addon:${tenantId}:${lockSku}`;
    // SA-769: a comp enable whose caller already holds this key (business-profile confirm) runs under that
    // lock; everything else - the admin route, a billed enable - takes it here, exactly as before.
    const callerHoldsLock = comp && opts?.lockHeld === true;
    const underLock: typeof withAdvisoryLock = callerHoldsLock
      ? async (_lockOpts, fn) => ({ acquired: true as const, value: await fn() })
      : withAdvisoryLock;
    try {
      const result = await underLock(
        { family: "billing", key: lockKey, mode: "wait", waitMs: 10_000 },
        async () => {
          // Check if add-on already exists — keyed either way (#2188 / SA-385).
          const existing = await findAddonRow(this.prisma, tenantId, lockSku);

          if (existing?.active && !(uncomp && existing.isComp)) {
            throw new ConflictException(
              `Add-on "${addonKey}" is already active for tenant ${tenant.slug}`,
            );
          }
          // SA-693: an uncomp only ever bills an ACTIVE comp, judged HERE under the lock. `uncompAddon`
          // read the row before taking it, so a comp disabled (or already uncomped) in between must be
          // refused, never re-activated and billed.
          if (uncomp && !(existing?.active && existing.isComp)) {
            throw new ConflictException(
              `Add-on "${addonKey}" is no longer an active comp for tenant ${tenant.slug}`,
            );
          }

          // SA-693 (M3): an uncomp keeps the comp's own quantity (a comp of 3 is billed as 3, never cut to
          // 1); every other enable is a boolean grant whose Stripe item is quantity 1.
          const qty = uncomp && existing?.isComp ? existing.quantity : 1;
          const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey;
          const isBridged = LEGACY_ADDON_KEY_TO_SKU[addonKey] !== undefined;

          // Only fetch catalog if bridged (must validate SKU exists) or if billing (must validate SKU is priceable)
          let skuDef: PlanVersionWithCatalog["addonSkus"][number] | null = null;
          if (isBridged || stripePriceId) {
            const published = await this.catalog.getPublishedCatalog();
            skuDef = published.addonSkus.find((s) => s.sku === sku) ?? null;

            // Bridged keys must exist in catalog — otherwise EntitlementsService.compute() can never
            // turn it into a flag, which is how the sales-agents "not available on your plan" outage happened.
            if (isBridged && !skuDef)
              throw new BadRequestException(
                `Addon '${addonKey}' maps to SKU '${sku}' which is not in the published catalog — ` +
                  `publish the catalog version that defines it first`,
              );

            // B865 / SA-277: a billed add-on must be priceable from the catalog — fail closed BEFORE any Stripe write.
            if (stripePriceId && !skuDef) {
              throw new BadRequestException(
                `Add-on "${addonKey}" has no catalog SKU to price — publish a catalog version defining "${sku}" before billing it`,
              );
            }

            // SA-786 S7 (owner ruling 2026-10-15): at a plan that INCLUDES the SKU the add-on is free once enabled, so a
            // Stripe item on top would book a charge the plan already covers. Refused BEFORE any Stripe call or row
            // write; without a price the enable proceeds below at $0. An unparseable includedAtPlan fails closed.
            if (stripePriceId && skuDef) {
              // SA-815a: judged by the tenant's own pinned catalog (sub pin, else tenant pin, else published). A SKU the
              // pinned version predates falls back to the published definition (as the entitlement resolver does).
              const { planKey, pinned } = await this.inclusionContextOf(
                tenantId,
                tenant,
                published,
              );
              const inclusionDef = pinned.addonSkus.find((s) => s.sku === sku) ?? skuDef;
              const verdict =
                inclusionDef.includedAtPlan != null
                  ? inclusionOf(inclusionDef, planKey)
                  : ({ kind: "NOT_INCLUDED" } as const);
              if (verdict.kind === "CATALOG_INVALID") {
                throw addonCatalogInvalidException(verdict.sku, verdict.value);
              }
              if (verdict.kind === "INCLUDED") {
                const planName =
                  pinned.definitions.find((d) => d.planKey === planKey)?.name ?? planKey;
                throw new ConflictException({
                  code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
                  message: `This add-on is included in ${planName}. Enable it without a price.`,
                });
              }
            }
          }

          // FIX-865B finding #1: only write `sku` when it actually resolved to a catalog SKU
          // (bridged legacy key, or an unbridged key whose SKU we looked up above). An
          // unbridged key with no catalog entry (e.g. "developer_mode") must keep sku null —
          // writing the raw addonKey there makes `addonSkuCode()` treat it as a real SKU,
          // which leaks it into EntitlementsService.compute()'s `activeCodes` / `ent.addons`
          // and the catalog-refetch warning, none of which the spec asked to change.
          const skuToStore = isBridged || skuDef ? sku : null;

          // Add Stripe subscription item if configured. A price means this add-on is
          // billed — the entitlement and the Stripe item must move together, so any
          // failure here refuses the whole call instead of silently granting an
          // unbilled add-on.
          let stripeItemId: string | null = null;
          if (stripePriceId && this.stripe.isConfigured) {
            const sub = await this.prisma.tenantSubscription.findUnique({
              where: { tenantId },
            });
            if (!sub?.stripeSubId) {
              // A handled 4xx leaves no other trace — Sentry captures >= 500 only and there is no
              // access log — so the refusal is logged like addon.guard.ts's denials.
              this.logger.warn(
                `Add-on "${addonKey}" refused for tenant ${tenant.slug} — priced add-on with no Stripe subscription`,
              );
              throw new ConflictException(
                `Tenant ${tenant.slug} has no active Stripe subscription — cannot bill add-on ` +
                  `"${addonKey}"; subscribe the tenant to a paid plan first`,
              );
            }
            try {
              const item = await this.stripe.client.subscriptionItems.create({
                subscription: sub.stripeSubId,
                price: stripePriceId,
                quantity: qty,
              });
              stripeItemId = item.id;
              this.logger.log(
                `Stripe subscription item ${item.id} added for add-on "${addonKey}" on tenant ${tenant.slug}`,
              );
            } catch (err) {
              this.logger.error(
                `Failed to add Stripe item for add-on "${addonKey}" on tenant ${tenant.slug}: ${(err as Error).message}`,
              );
              throw new ServiceUnavailableException(
                `Could not create the Stripe subscription item for add-on "${addonKey}" — the add-on ` +
                  `was not enabled; retry, or check the tenant's Stripe subscription`,
              );
            }
          }

          // B865 / SA-277 FIX-5: a catalog price is only booked when a Stripe item was
          // ACTUALLY created — Stripe not configured (or no stripePriceId) means the add-on
          // is unbilled, so it is priced EXPLICITLY at 0 and books nothing (D1).
          const priceSnapshot = stripeItemId && skuDef ? Number(skuDef.monthlyPrice) : 0;

          // Upsert the add-on record and emit ledger delta in a transaction
          const addon = await this.prisma.$transaction(async (tx) => {
            // B865 / SA-277 FIX-2 (house lock order): tenant row lock FIRST, before any
            // TenantAddon read or write, so this and every other add-on-ledger $transaction
            // always take the SAME order and can never deadlock against each other.
            await lockTenantForLedger(tx, tenantId);

            // F2 (pre-merge review): `existing?.active` above was checked OUTSIDE this tx,
            // before the Stripe item (if any) was even created — a concurrent subscribe()
            // (subscription-mutation.service.ts, which holds no advisory lock against this
            // admin path) can activate the SAME row at some quantity in the window between
            // that check and here, in which case this call's {0,0}→{priceSnapshot,1} booking
            // below would double the already-booked contribution. Re-check under the lock: if
            // the row is now active, this call lost the race — refuse it exactly like the
            // pre-check does, and best-effort delete the orphan Stripe item THIS call already
            // created (mirroring disableAddon's own Stripe-cleanup handling) rather than leave
            // a live item nothing points to.
            const current = await findAddonRow(tx, tenantId, lockSku);
            // SA-693: for an uncomp the lost race is "no longer an ACTIVE comp"; for any other enable it
            // is "now active". Both clean up the orphan Stripe item below.
            const lostRace = uncomp ? !(current?.active && current.isComp) : current?.active;
            if (lostRace) {
              if (stripeItemId) {
                try {
                  await this.stripe.client.subscriptionItems.del(stripeItemId);
                } catch (err) {
                  if (!isStripeResourceMissing(err)) {
                    this.logger.error(
                      `Add-on "${addonKey}" lost the activation race for tenant ${tenant.slug} ` +
                        `and could not clean up the orphan Stripe item ${stripeItemId}: ` +
                        `${(err as Error).message}`,
                    );
                  }
                }
              }
              throw new ConflictException(
                `Add-on "${addonKey}" is already active for tenant ${tenant.slug}`,
              );
            }

            // #2188 / SA-385: an existing row — keyed by this legacy addonKey OR by the SKU a
            // self-serve/subscribe path wrote — is re-activated IN PLACE, by its OWN addonKey;
            // only when there is none is a new row created, under this path's (raw) key.
            const row = await upsertAddonRowTx(tx, this.events, {
              tenantId,
              addonKey: current?.addonKey ?? addonKey,
              actor: {
                kind: "PLATFORM_ADMIN",
                id: opts?.actorId ?? null,
                source: (callerHoldsLock
                  ? "profile.apply"
                  : comp
                    ? "admin.comp"
                    : uncomp
                      ? "admin.uncomp"
                      : "admin.enable") satisfies AddonChangeSource,
              },
              create: {
                tenantId,
                addonKey,
                sku: skuToStore,
                stripePriceId: stripePriceId ?? null,
                stripeItemId,
                active: true,
                // The Stripe item (when one exists) carries `qty` — mirror it here so a stale
                // quantity from a prior admin-only grant never survives a re-enable.
                quantity: qty,
                priceSnapshot,
                isComp: comp,
              },
              update: {
                active: true,
                // SA-693: written on EVERY enable, so a re-activated row never keeps a stale flag
                // (a billed enable of a disabled comp resets it; a comp enable sets it).
                isComp: comp,
                // FIX-865B finding #1 (r2): `skuToStore` is null whenever this enable is
                // unbridged with no resolvable catalog SKU (e.g. a legacy key re-enabled by
                // an admin with no stripePriceId) — that says nothing about whether the
                // EXISTING row already has a correct sku from an earlier enable. `sku: null`
                // here would overwrite that good value and make addonSkuCode() drop the
                // add-on from entitlements even though the row is active. Fall through to
                // `undefined` (leave the column untouched) instead of clobbering it; only the
                // create branch below may legitimately write a fresh row's sku as null.
                sku: skuToStore ?? undefined,
                stripePriceId: comp ? null : (stripePriceId ?? undefined),
                // SA-693: a comp never carries a Stripe item pointer, so a stale one is cleared.
                stripeItemId: comp ? null : (stripeItemId ?? undefined),
                // B865 / SA-277: the Stripe item carries `qty` — a stale quantity from an earlier
                // grant must not survive a re-enable.
                quantity: qty,
                priceSnapshot,
              },
            });
            // B865 / SA-277 FIX-1: the new before/after contract — a fresh grant always moves
            // from {0,0} to {priceSnapshot, 1}; `emitAddonDelta` itself no-ops a zero delta.
            await emitAddonDelta(tx, this.events, {
              tenantId,
              sku,
              before: { priceSnapshot: 0, quantity: 0 },
              after: { priceSnapshot, quantity: qty },
            });
            return row;
          });

          this.entitlements.invalidate(tenantId);
          // B509: the Feature Console's "effective" view reads FeatureResolverService's own
          // 30s cache, which entitlements.invalidate() above does not touch — without this,
          // the console could show the pre-toggle value for up to 30s after an admin enables
          // an add-on. Real enforcement (AddonGuard/DriverPaymentsGuard) is unaffected — it
          // reads TenantAddon via Prisma directly, uncached.
          this.featureResolver.invalidate(tenantId);
          this.logger.log(
            `Add-on "${addonKey}" enabled for tenant ${tenant.slug}` +
              (comp && opts?.reason
                ? ` as a comp (${opts.reason}, by ${opts.actorId ?? "?"})`
                : ""),
          );
          return addon;
        },
      );

      if (!result.acquired) {
        // Unreachable under `mode: "wait"` (it either acquires or the catch below maps a
        // `LockTimeoutError`) — kept only so this exhaustively narrows `LockResult` without a cast.
        throw new ServiceUnavailableException(
          `Could not enable add-on "${addonKey}" for tenant ${tenant.slug} — lock unavailable`,
        );
      }
      return result.value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        this.logger.error(
          `Add-on "${addonKey}" lock unavailable for tenant ${tenant.slug}: ${(e as Error).message}`,
        );
        throw new ServiceUnavailableException(
          `Could not serialise enabling add-on "${addonKey}" for tenant ${tenant.slug} — retry shortly`,
        );
      }
      throw e;
    }
  }

  /**
   * The plan the tenant is on, resolved as everywhere in billing: the subscription's `planKey`, else the legacy
   * `Tenant.plan` enum. Null when neither is known (then no add-on is "included").
   */
  /**
   * SA-815a: what an inclusion judgment on this tenant needs - the plan it is on and the catalog it is pinned to
   * (sub pin, else tenant pin, else published; `published` is reused when it is the resolved one).
   */
  private async inclusionContextOf(
    tenantId: string,
    tenant: { plan?: string | null; planVersionId?: string | null },
    published: PlanVersionWithCatalog,
  ): Promise<{ planKey: string | null; pinned: PlanVersionWithCatalog }> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { planKey: true, planVersionId: true },
    });
    const planKey =
      normalizePlanKey(sub?.planKey) ?? (tenant.plan ? planKeyFromEnum(tenant.plan) : null);
    return { planKey, pinned: await inclusionCatalogFor(this.catalog, sub, tenant, published) };
  }

  private async currentPlanKeyOf(
    tenantId: string,
    tenantPlan?: string | null,
  ): Promise<string | null> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { planKey: true },
    });
    const fromSub = normalizePlanKey(sub?.planKey);
    if (fromSub) return fromSub;
    const plan =
      tenantPlan ??
      (await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }))
        ?.plan;
    return plan ? planKeyFromEnum(plan) : null;
  }

  /**
   * SA-693: turn an ACTIVE comp row back into a normal (non-comp) one. It NEVER silently starts billing:
   *  - tenant WITHOUT a Stripe subscription: only the flag flips (the row stays unbilled, price 0, as it
   *    was); the SA-690 checkout gate then treats it like any other unbilled self-serve row.
   *  - tenant WITH a Stripe subscription: the normal BILLED enable path runs (a catalog price id is
   *    required, a Stripe item is created, the price is booked) via `enableAddon(..., { uncomp: true })`.
   *    It refuses 400 without a price id rather than leave an active unbilled row on a paying tenant. A
   *    Stripe failure leaves the comp exactly as it was.
   * Takes the SAME advisory key as enableAddon and the self-serve path. Disable is a different path and
   * takes no lock (see `disableAddon`).
   */
  async uncompAddon(tenantId: string, addonKey: string, stripePriceId?: string, actorId?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, planVersionId: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const lockSku = addonCodeOf(addonKey);
    const row = await findAddonRow(this.prisma, tenantId, lockSku);
    if (!row) throw new NotFoundException(`Add-on "${addonKey}" not found for tenant ${tenantId}`);
    if (!row.active || !row.isComp) {
      throw new ConflictException(
        `Add-on "${addonKey}" is not an active comp for tenant ${tenant.slug}`,
      );
    }

    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    // SA-786 S8: at a plan that INCLUDES the SKU the add-on is free, so un-comping only drops the comp marker: no
    // price, no DUE notice, no Stripe re-entry (and no stripePriceId needed). An unparseable includedAtPlan fails
    // closed (409, B1102).
    const published = await this.catalog.getPublishedCatalog();
    const catalogSku = published.addonSkus.find((k) => k.sku === lockSku) ?? null;
    let includedHere = false;
    // SA-815a: inclusion is judged by the tenant's own pinned catalog (sub pin, else tenant pin, else published); a
    // SKU the pinned version predates falls back to the published definition. The price below stays the published one.
    const pinnedCatalog = await inclusionCatalogFor(this.catalog, sub, tenant, published);
    const inclusionSku = pinnedCatalog.addonSkus.find((k) => k.sku === lockSku) ?? catalogSku;
    if (inclusionSku?.includedAtPlan != null) {
      const verdict = inclusionOf(
        inclusionSku,
        normalizePlanKey(sub?.planKey) ?? (await this.currentPlanKeyOf(tenantId)),
      );
      if (verdict.kind === "CATALOG_INVALID") {
        throw addonCatalogInvalidException(verdict.sku, verdict.value);
      }
      includedHere = verdict.kind === "INCLUDED";
    }
    // A manually-invoiced tenant (externalPayment, no Stripe subscription): turning the comp off means
    // the owner now invoices it by hand, exactly like a self-serve enable there. Priced at the catalog
    // price and booked, with the same ADDON_MANUAL_INVOICE_DUE notice; without a catalog SKU it stays flag-only.
    const manual = !includedHere && !sub?.stripeSubId && sub?.externalPayment === true;
    const manualSkuDef = manual ? catalogSku : null;
    if (!includedHere && sub?.stripeSubId) {
      // Without a configured Stripe the billed enable would write an ACTIVE, unbilled, non-comp row at 0
      // on a tenant that has a subscription: the exact silent state this method must never create.
      if (!this.stripe.isConfigured) {
        throw new ConflictException({
          code: API_ERROR_CODES.ADDON_UNCOMP_STRIPE_UNAVAILABLE,
          message:
            `Stripe is not configured here, so "${addonKey}" cannot be billed for tenant ${tenant.slug} — ` +
            `it stays a comp; uncomp it where Stripe is configured`,
        });
      }
      if (!stripePriceId) {
        throw new BadRequestException(
          `Tenant ${tenant.slug} has a Stripe subscription — pass the add-on's stripePriceId to bill ` +
            `"${addonKey}", or disable it; uncomping must never leave an active add-on unbilled`,
        );
      }
      const billedRow = await this.enableAddon(tenantId, addonKey, stripePriceId, true, {
        uncomp: true,
        actorId,
      });
      return { addon: billedRow, billing: UncompBilling.STRIPE };
    }

    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: `addon:${tenantId}:${lockSku}`, mode: "wait", waitMs: 10_000 },
        async () => {
          const updated = await this.prisma.$transaction(async (tx) => {
            await lockTenantForLedger(tx, tenantId);
            const current = await findAddonRow(tx, tenantId, lockSku);
            if (!current?.active || !current.isComp) {
              throw new ConflictException(
                `Add-on "${addonKey}" is not an active comp for tenant ${tenant.slug}`,
              );
            }
            const actor = {
              kind: "PLATFORM_ADMIN" as const,
              id: actorId ?? null,
              source: "admin.uncomp" as const,
            };
            if (!manualSkuDef) {
              return updateAddonRowTx(tx, this.events, {
                id: current.id,
                data: { isComp: false },
                actor,
              });
            }
            const price = roundMoney(Number(manualSkuDef.monthlyPrice));
            const row = await updateAddonRowTx(tx, this.events, {
              id: current.id,
              data: { isComp: false, priceSnapshot: price },
              actor,
            });
            await emitAddonDelta(tx, this.events, {
              tenantId,
              sku: lockSku,
              before: { priceSnapshot: 0, quantity: current.quantity },
              after: { priceSnapshot: price, quantity: current.quantity },
            });
            await tx.auditLog.create({
              data: {
                tenantId,
                userId: null,
                action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE,
                entityType: ADMIN_AUDIT_ENTITY,
                entityId: tenantId,
                meta: {
                  platformAdmin: true,
                  sku: lockSku,
                  quantity: current.quantity,
                  monthlyPrice: price,
                  addonName: manualSkuDef.name,
                  kind: "add",
                  fromQty: 0,
                  toQty: current.quantity,
                  message: `Add-on ${manualSkuDef.name} comp removed for ${tenant.name ?? tenant.slug}: add to their next manual invoice`,
                },
              },
            });
            return row;
          });
          this.entitlements.invalidate(tenantId);
          this.featureResolver.invalidate(tenantId);
          this.logger.log(`Add-on "${addonKey}" uncomped (flag only) for tenant ${tenant.slug}`);
          return {
            addon: updated,
            billing: manualSkuDef ? UncompBilling.MANUAL : UncompBilling.UNBILLED,
          };
        },
      );
      if (!result.acquired) {
        throw new ServiceUnavailableException(
          `Could not uncomp add-on "${addonKey}" for tenant ${tenant.slug} — lock unavailable`,
        );
      }
      return result.value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        throw new ServiceUnavailableException(
          `Could not serialise uncomping add-on "${addonKey}" for tenant ${tenant.slug} — retry shortly`,
        );
      }
      throw e;
    }
  }

  /**
   * Disable an add-on for a tenant.
   *
   * SA-671d: this path takes NO advisory lock, and must never gain one. Business-profile confirm
   * (`withConfirmLock`, #3199) calls it while already holding the add-on advisory keys, so a lock here
   * would wait on a key its own caller holds and self-block the confirm. The row-level `FOR UPDATE` in
   * the transaction below is the only serialisation. Pinned in addon.comp.sa693.spec.ts.
   *
   * If the add-on has a Stripe subscription item, it must actually be removed
   * (or already gone) before the entitlement is turned off — a Stripe failure
   * other than "already deleted" refuses the call so we never keep billing for
   * an add-on the tenant no longer has.
   */
  async disableAddon(
    tenantId: string,
    addonKey: string,
    actorId?: string,
    // SA-822: a business-profile apply that switches an add-on off says so (the closed source list's `profile.apply`)
    source: "admin.disable" | "profile.apply" = "admin.disable",
  ) {
    // Owner ruling 2026-09-28 / SA-540: a default-granted key is held with NO row, so disabling a
    // row would report success and remove nothing. Only a DENY override removes it — say so.
    if (DEFAULT_GRANTED_ADDON_FEATURES.some((f) => f.key === addonKey)) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.ADDON_DEFAULT_GRANTED,
        addonKey,
        message:
          `"${addonKey}" is granted to every eligible tenant by default, so disabling its add-on ` +
          `row would not remove it. Add a DENY feature override for this tenant instead.`,
      });
    }
    // #2188 / SA-385: finds the row whichever way it was keyed (legacy key or SKU).
    const addon = await findAddonRow(this.prisma, tenantId, addonCodeOf(addonKey));

    if (!addon) {
      throw new NotFoundException(`Add-on "${addonKey}" not found for tenant ${tenantId}`);
    }

    // Remove Stripe subscription item if exists
    if (addon.stripeItemId && this.stripe.isConfigured) {
      try {
        await this.stripe.client.subscriptionItems.del(addon.stripeItemId);
        this.logger.log(
          `Stripe subscription item ${addon.stripeItemId} removed for add-on "${addonKey}"`,
        );
      } catch (err) {
        if (!isStripeResourceMissing(err)) {
          this.logger.error(
            `Failed to remove Stripe item ${addon.stripeItemId} for add-on "${addonKey}": ${(err as Error).message}`,
          );
          throw new ServiceUnavailableException(
            `Could not remove the Stripe subscription item ${addon.stripeItemId} for add-on ` +
              `"${addonKey}" — the add-on was not disabled; retry, or remove the item in Stripe ` +
              `directly and try again`,
          );
        }
        // Already gone in Stripe — treat as success and clear the pointer below.
        this.logger.warn(
          `Stripe subscription item ${addon.stripeItemId} for add-on "${addonKey}" was already ` +
            `removed; clearing the local pointer`,
        );
      }
    }

    // FIX-865B finding #0: `addon` above was read outside the transaction and before any
    // lock, so two concurrent disables can both observe active=true and both emit a
    // −snapshot×qty ledger delta (the Tenant FOR UPDATE lock inside `emitAddonDelta` only
    // serialises the two transactions — it never re-checks `active`). Lock the row FIRST,
    // then re-read it INSIDE the transaction and gate the update + emit on THAT read: the
    // first transaction to acquire the lock sees active=true and proceeds; a concurrent
    // second transaction blocks on the row lock until the first commits, then sees
    // active=false already and no-ops instead of emitting a second delta.
    const updated = await this.prisma.$transaction(async (tx) => {
      // B865 / SA-277 FIX-2 (house lock order): tenant row lock FIRST, before the TenantAddon
      // row lock below.
      await lockTenantForLedger(tx, tenantId);
      await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE id = ${addon.id} FOR UPDATE`;
      const current = await tx.tenantAddon.findUnique({
        where: { tenantId_addonKey: { tenantId, addonKey: addon.addonKey } },
      });
      if (!current?.active) {
        // Already disabled by a concurrent call that won the race — nothing left to do.
        return current ?? addon;
      }
      const row = await updateAddonRowTx(tx, this.events, {
        id: current.id,
        data: { active: false, stripeItemId: null },
        actor: {
          kind: "PLATFORM_ADMIN",
          id: actorId ?? null,
          source: source === "profile.apply" ? "profile.apply" : "admin.disable",
        },
      });
      // B865 / SA-277 FIX-6: the event's sku is the CANONICAL code (bridges a legacy addonKey
      // the same way subscription-mutation.service.ts's self-serve disable does), falling back
      // to the legacy map / raw key when the row never resolved a catalog sku.
      await emitAddonDelta(tx, this.events, {
        tenantId,
        sku: addonSkuCode(current) ?? addonCodeOf(addonKey),
        before: { priceSnapshot: current.priceSnapshot, quantity: current.quantity },
        after: { priceSnapshot: 0, quantity: 0 },
        actorId,
      });
      return row;
    });

    this.entitlements.invalidate(tenantId);
    // B509: see the matching comment in enableAddon — the resolver cache needs its own
    // invalidation, separate from entitlements.invalidate().
    this.featureResolver.invalidate(tenantId);
    this.logger.log(`Add-on "${addonKey}" disabled for tenant ${tenantId}`);
    return updated;
  }
}
