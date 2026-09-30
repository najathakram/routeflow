import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { findPlanDefinition, normalizePlanKey } from "./plan-catalog.constants";

export type PricingSource = "override" | "catalog";

export interface ResolvedTenantPricing {
  planKey: string;
  planName: string;
  /** Dollars (not cents). */
  monthly: number;
  /** Dollars (not cents). */
  annual: number;
  source: PricingSource;
  currency: "usd";
}

export interface CheckoutPriceData {
  currency: "usd";
  product_data: { name: string };
  /** Integer cents — Stripe requires unit_amount as an integer. */
  unit_amount: number;
  recurring: { interval: "month" | "year" };
}

/**
 * Resolves what a tenant should actually be charged: a per-tenant custom fee
 * (`TenantSubscription.priceOverride{Monthly,Annual}`) beats the catalog; absent an
 * override, the tenant's PINNED PlanVersion's PlanDefinition for its current planKey
 * is the source of truth. Catalog numbers are plans-as-data — Stripe is never asked
 * for a price, it is TOLD one (inline `price_data`) at checkout/sync time.
 *
 * Annual prepay = 2 months free: `annualPrice ?? monthlyPrice * 10`, computed here so
 * every caller (checkout, admin resolver endpoint, subscription sync) agrees.
 */
@Injectable()
export class PlatformPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planCatalog: PlanCatalogService,
  ) {}

  /**
   * Resolve the monthly/annual price (in dollars) a tenant should be charged, and
   * where it came from. Throws BadRequestException when neither an override nor a
   * catalog price exists (e.g. an ENTERPRISE / `isCustom` plan with no custom fee
   * set yet — the admin must set one via the price-override endpoint first).
   */
  async resolveTenantPricing(tenantId: string): Promise<ResolvedTenantPricing> {
    return this.resolve(tenantId, false);
  }

  /**
   * The price the tenant would resolve to from its PINNED catalog version ALONE,
   * ignoring any custom fee. Callers use it to check — BEFORE writing — that
   * clearing (or partially clearing) an override leaves a billable tenant behind;
   * it throws the same BadRequestException when the plan has no catalog price.
   */
  async resolveCatalogPricing(tenantId: string): Promise<ResolvedTenantPricing> {
    return this.resolve(tenantId, true);
  }

  private async resolve(
    tenantId: string,
    ignoreOverrides: boolean,
  ): Promise<ResolvedTenantPricing> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        plan: true,
        planVersionId: true,
        subscription: {
          select: {
            planKey: true,
            priceOverrideMonthly: true,
            priceOverrideAnnual: true,
          },
        },
      },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const planKey = normalizePlanKey(tenant.subscription?.planKey ?? tenant.plan) ?? "STARTER";

    // Read the tenant's own PINNED version, never latest — grandfathered tenants
    // (older PlanVersion) must resolve against their own PlanDefinition rows.
    const version = await this.planCatalog.getVersionForTenant(tenant.planVersionId);
    const definition = findPlanDefinition(version.definitions, planKey);
    const planName = definition?.name ?? planKey;

    const overrideMonthly = ignoreOverrides ? null : tenant.subscription?.priceOverrideMonthly;
    const overrideAnnual = ignoreOverrides ? null : tenant.subscription?.priceOverrideAnnual;
    // `annualPrice` of 0 is a DELIBERATE promotional price (free first year) — test for
    // null, never truthiness, or a 0 silently becomes "10× monthly".
    const catalogMonthly =
      definition?.monthlyPrice != null ? Number(definition.monthlyPrice) : null;
    const catalogAnnual = definition?.annualPrice != null ? Number(definition.annualPrice) : null;

    // Either override column on its own counts as a custom fee: an annual-only fee is a
    // real negotiated case (annual prepay discount off the catalog monthly), and silently
    // ignoring it would bill the catalog price to a tenant the admin already re-priced.
    if (overrideMonthly != null || overrideAnnual != null) {
      const monthly = overrideMonthly != null ? Number(overrideMonthly) : catalogMonthly;
      if (monthly == null) {
        throw new BadRequestException(
          `No monthly price is resolvable for tenant ${tenantId} on plan ${planKey}. ` +
            `This plan has no catalog price (custom/Enterprise) and only an annual custom ` +
            `fee is set — set a custom MONTHLY fee too.`,
        );
      }
      const annual = overrideAnnual != null ? Number(overrideAnnual) : monthly * 10;
      return { planKey, planName, monthly, annual, source: "override", currency: "usd" };
    }

    if (catalogMonthly == null) {
      throw new BadRequestException(
        `No price is resolvable for tenant ${tenantId} on plan ${planKey}. ` +
          `This plan has no catalog price (custom/Enterprise) — set a custom fee first.`,
      );
    }
    const annual = catalogAnnual != null ? catalogAnnual : catalogMonthly * 10;
    return {
      planKey,
      planName,
      monthly: catalogMonthly,
      annual,
      source: "catalog",
      currency: "usd",
    };
  }

  /**
   * Build the Stripe Checkout `price_data` line item for a tenant + billing interval.
   * Integer cents — `Math.round` guards float drift (e.g. 249 * 100).
   */
  async checkoutPriceData(
    tenantId: string,
    interval: "month" | "year",
  ): Promise<CheckoutPriceData> {
    const pricing = await this.resolveTenantPricing(tenantId);
    const amount = interval === "year" ? pricing.annual : pricing.monthly;
    return {
      currency: pricing.currency,
      product_data: {
        name: `RouteFlow ${pricing.planName} — ${interval === "year" ? "annual" : "monthly"}`,
      },
      unit_amount: Math.round(amount * 100),
      recurring: { interval },
    };
  }
}
