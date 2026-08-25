import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { EntitlementsService } from "./entitlements.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { LEGACY_ADDON_KEY_TO_SKU } from "./plan-catalog.constants";

/**
 * Manages add-on features for tenants.
 *
 * Each add-on is a key-value pair (e.g. "ai_scanning", "advanced_routes")
 * that can be toggled on/off per tenant. When Stripe is configured, enabling
 * an add-on also creates a Stripe subscription item for billing.
 */
@Injectable()
export class AddonService {
  private readonly logger = new Logger(AddonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
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
   * If Stripe is configured and a stripePriceId is provided, it also creates
   * a Stripe subscription item for billing.
   */
  async enableAddon(tenantId: string, addonKey: string, stripePriceId?: string) {
    // Check tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

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

    // Add Stripe subscription item if configured
    let stripeItemId: string | null = null;
    if (stripePriceId && this.stripe.isConfigured) {
      const sub = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
      });
      if (sub?.stripeSubId) {
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
            `Failed to add Stripe item for add-on "${addonKey}": ${(err as Error).message}`,
          );
          // Continue — don't block add-on activation over Stripe failure
        }
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
    this.logger.log(`Add-on "${addonKey}" enabled for tenant ${tenant.slug}`);
    return addon;
  }

  /**
   * Disable an add-on for a tenant.
   * If the add-on has a Stripe subscription item, it will be removed.
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
        this.logger.error(
          `Failed to remove Stripe item ${addon.stripeItemId}: ${(err as Error).message}`,
        );
      }
    }

    const updated = await this.prisma.tenantAddon.update({
      where: { tenantId_addonKey: { tenantId, addonKey } },
      data: { active: false, stripeItemId: null },
    });

    this.entitlements.invalidate(tenantId);
    this.logger.log(`Add-on "${addonKey}" disabled for tenant ${tenantId}`);
    return updated;
  }
}
