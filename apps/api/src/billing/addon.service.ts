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
import { PlanCatalogService } from "./plan-catalog.service";
import { LEGACY_ADDON_KEY_TO_SKU } from "./plan-catalog.constants";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";

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
@Injectable()
export class AddonService {
  private readonly logger = new Logger(AddonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
    private readonly featureResolver: FeatureResolverService,
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
    const addon = await this.prisma.tenantAddon.findUnique({
      where: { tenantId_addonKey: { tenantId, addonKey } },
      select: { active: true },
    });
    return addon?.active === true;
  }

  /**
   * Get all active add-ons for a tenant.
   */
  async getActiveAddons(tenantId: string): Promise<string[]> {
    const addons = await this.prisma.tenantAddon.findMany({
      where: { tenantId, active: true },
      select: { addonKey: true },
    });
    return addons.map((a) => a.addonKey);
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
  async enableAddon(tenantId: string, addonKey: string, stripePriceId?: string) {
    // Check tenant exists — not part of the race (immutable for this call), so it stays
    // outside the lock.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

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
    const lockSku = LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey;
    const lockKey = `addon:${tenantId}:${lockSku}`;
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: lockKey, mode: "wait", waitMs: 10_000 },
        async () => {
          // Check if add-on already exists
          const existing = await this.prisma.tenantAddon.findUnique({
            where: { tenantId_addonKey: { tenantId, addonKey } },
          });

          if (existing?.active) {
            throw new ConflictException(
              `Add-on "${addonKey}" is already active for tenant ${tenant.slug}`,
            );
          }

          // Bridged legacy keys (tobacco_dealer, msrp, sales_agents, …) must resolve to a SKU
          // that actually exists in the published catalog — otherwise the row activates but
          // EntitlementsService.compute() can never turn it into a flag (see the silent-continue
          // fix there), which is how the sales-agents "not available on your plan" outage
          // happened. Unbridged legacy keys (e.g. developer_mode) have no SKU to check and are
          // allowed unchanged — that is the documented client-only pattern.
          const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey];
          if (sku) {
            const published = await this.catalog.getPublishedCatalog();
            const skuIsPublished = published.addonSkus.some((s) => s.sku === sku);
            if (!skuIsPublished) {
              throw new BadRequestException(
                `Addon '${addonKey}' maps to SKU '${sku}' which is not in the published catalog — ` +
                  `publish the catalog version that defines it first`,
              );
            }
          }

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
                quantity: 1,
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

          // Upsert the add-on record
          const addon = await this.prisma.tenantAddon.upsert({
            where: { tenantId_addonKey: { tenantId, addonKey } },
            create: {
              tenantId,
              addonKey,
              stripePriceId: stripePriceId ?? null,
              stripeItemId,
              active: true,
            },
            update: {
              active: true,
              stripePriceId: stripePriceId ?? undefined,
              stripeItemId: stripeItemId ?? undefined,
            },
          });

          this.entitlements.invalidate(tenantId);
          // B509: the Feature Console's "effective" view reads FeatureResolverService's own
          // 30s cache, which entitlements.invalidate() above does not touch — without this,
          // the console could show the pre-toggle value for up to 30s after an admin enables
          // an add-on. Real enforcement (AddonGuard/DriverPaymentsGuard) is unaffected — it
          // reads TenantAddon via Prisma directly, uncached.
          this.featureResolver.invalidate(tenantId);
          this.logger.log(`Add-on "${addonKey}" enabled for tenant ${tenant.slug}`);
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
   * Disable an add-on for a tenant.
   * If the add-on has a Stripe subscription item, it must actually be removed
   * (or already gone) before the entitlement is turned off — a Stripe failure
   * other than "already deleted" refuses the call so we never keep billing for
   * an add-on the tenant no longer has.
   */
  async disableAddon(tenantId: string, addonKey: string) {
    const addon = await this.prisma.tenantAddon.findUnique({
      where: { tenantId_addonKey: { tenantId, addonKey } },
    });

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

    const updated = await this.prisma.tenantAddon.update({
      where: { tenantId_addonKey: { tenantId, addonKey } },
      data: { active: false, stripeItemId: null },
    });

    this.entitlements.invalidate(tenantId);
    // B509: see the matching comment in enableAddon — the resolver cache needs its own
    // invalidation, separate from entitlements.invalidate().
    this.featureResolver.invalidate(tenantId);
    this.logger.log(`Add-on "${addonKey}" disabled for tenant ${tenantId}`);
    return updated;
  }
}
