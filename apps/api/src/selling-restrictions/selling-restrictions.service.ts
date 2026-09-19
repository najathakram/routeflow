import { Injectable, Logger } from "@nestjs/common";
import type {
  RestrictionAddressPrecedence,
  RestrictionChannel,
  RestrictionsEvaluation,
  RestrictionsPolicy,
} from "@routeflow/types";
import { assertAmbientTenant } from "../common/ambient-tenant";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import {
  anyRuleNeedsState,
  evaluateRestrictions,
  matchingRules,
  offEvaluation,
  resolveGoverningState,
  ruleStates,
  UNRESOLVED_STATE,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";

export interface EvaluateLine {
  productId: string;
}

export interface EvaluateOptions {
  /** Defaults to STAFF (every path except the self-serve buyer portal). */
  channel?: RestrictionChannel;
  /** Point-in-time evaluation; defaults to now. */
  at?: Date;
}

/**
 * API-local mirror of `RESTRICTION_ADDRESS_PRECEDENCE_VALUES` (`packages/types/api/enums.ts`) — the
 * API can't value-import `@routeflow/types` (see `no-runtime-workspace-imports.spec.ts`); pinned
 * set-equal to the shared array by `restrictions-mirrors.parity.spec.ts`. The `satisfies` keeps it
 * a subset of the shared type at compile time.
 */
export const RESTRICTION_ADDRESS_PRECEDENCE_VALUES = [
  "BILLING_FIRST",
  "SHIPPING_FIRST",
] as const satisfies readonly RestrictionAddressPrecedence[];

/** `SystemConfig` keys for the tenant policy (plan §1.5). Step 6's settings endpoint writes them. */
export const SYSTEM_CONFIG_ENABLED = "selling_restrictions.enabled";
export const SYSTEM_CONFIG_GOVERNING_ADDRESS = "selling_restrictions.governing_address";

/**
 * Selling restrictions (lane R step 1): `evaluate()` answers "may this customer be sold these
 * products?" — OFF / ALLOW / BLOCK / INDETERMINATE. Thin Prisma adapter over the pure core in
 * `selling-restrictions.core.ts`. READ-ONLY; it never writes and never throws for a business
 * outcome (the step-2 choke point turns BLOCK/INDETERMINATE into the 409).
 *
 * Labels and lineage come from `ProductLabelsService.effectiveLabels` (the one implementation),
 * resolved from each product's CURRENT parent at evaluation time — never a snapshot — so
 * reparenting a variant cannot leave a stale opt-out in force.
 *
 * Tenant scoping (L-124): the choke point is also reached from cron paths with NO ambient tenant
 * context, where `forTenant()` silently returns the unscoped client — so every query carries an
 * explicit `tenantId`. When an ambient tenant DOES exist, `forTenant()` spreads it over the
 * explicit one, so `assertAmbientTenant` refuses a mismatch instead of quietly evaluating
 * another tenant's rules.
 */
@Injectable()
export class SellingRestrictionsService {
  private readonly logger = new Logger(SellingRestrictionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productLabels: ProductLabelsService,
  ) {}

  /**
   * The tenant's policy, from two `SystemConfig` rows (plan §1.5 — tenant-owned, so no new table):
   *   `selling_restrictions.enabled`           — absent or "false" = OFF (owner ruling: OFF by
   *                                               default); any other stored value = ON (an
   *                                               unrecognised value fails closed, never OFF).
   *   `selling_restrictions.governing_address` — "BILLING_FIRST" (default) | "SHIPPING_FIRST"; an
   *                                               unknown value parses to BILLING_FIRST with a warn.
   * A DB error propagates: an unreadable switch is never silently treated as OFF.
   */
  async getPolicy(tenantId: string): Promise<RestrictionsPolicy> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService");
    const rows: Array<{ key: string; value: string }> = await this.prisma
      .forTenant()
      .systemConfig.findMany({
        where: { tenantId, key: { in: [SYSTEM_CONFIG_ENABLED, SYSTEM_CONFIG_GOVERNING_ADDRESS] } },
        select: { key: true, value: true },
      });
    const value = (key: string) => rows.find((r) => r.key === key)?.value;
    const enabled = value(SYSTEM_CONFIG_ENABLED);
    return {
      enabled: enabled !== undefined && enabled.trim().toLowerCase() !== "false",
      addressPrecedence: this.parsePrecedence(tenantId, value(SYSTEM_CONFIG_GOVERNING_ADDRESS)),
    };
  }

  private parsePrecedence(tenantId: string, raw: string | undefined): RestrictionAddressPrecedence {
    if (raw === undefined) return "BILLING_FIRST";
    const normalized = raw.trim().toUpperCase();
    const known = RESTRICTION_ADDRESS_PRECEDENCE_VALUES.find((v) => v === normalized);
    if (known) return known;
    this.logger.warn(
      `${SYSTEM_CONFIG_GOVERNING_ADDRESS} has an unknown value for tenant ${tenantId}; using BILLING_FIRST`,
    );
    return "BILLING_FIRST";
  }

  async evaluate(
    tenantId: string,
    customerId: string | null,
    lines: readonly EvaluateLine[],
    options: EvaluateOptions = {},
  ): Promise<RestrictionsEvaluation> {
    const policy = await this.getPolicy(tenantId);
    if (!policy.enabled) return offEvaluation();

    const productIds = [...new Set(lines.map((l) => l.productId))];
    if (productIds.length === 0) return { outcome: "ALLOW", reasons: [] };

    const channel = options.channel ?? "STAFF";
    const at = options.at ?? new Date();
    const db = this.prisma.forTenant();

    const labels = await this.productLabels.effectiveLabels(tenantId, productIds);
    const products: ProductFacts[] = productIds.map((id) => {
      const l = labels.get(id);
      return {
        id,
        name: l?.name ?? id,
        effectiveCategoryIds: l?.effectiveCategoryIds ?? new Set<string>(),
        lineageIds: l?.lineageIds ?? new Set([id]),
        ...(l?.resolvable === false || !l ? { unresolvable: true } : {}),
      };
    });
    const categoryIds = new Set<string>();
    const lineageIds = new Set<string>();
    for (const p of products) {
      p.effectiveCategoryIds.forEach((c) => categoryIds.add(c));
      for (const id of p.lineageIds ?? new Set<string>()) lineageIds.add(id);
    }

    const rules: RestrictionRuleFacts[] = await db.sellingRestriction.findMany({
      where: {
        tenantId,
        OR: [
          { productId: { in: [...lineageIds] } },
          ...(categoryIds.size > 0 ? [{ categoryId: { in: [...categoryIds] } }] : []),
        ],
      },
      select: {
        id: true,
        categoryId: true,
        productId: true,
        jurisdiction: true,
        states: true,
        surface: true,
        effectiveFrom: true,
        effectiveTo: true,
        liftedAt: true,
        reason: true,
      },
    });

    // Load addresses only when some matching rule could actually need a state.
    const matched = products.flatMap((p) => matchingRules(rules, p, channel, at));

    // A matched STATE rule whose states can't all be read is treated as "blocks everywhere" (fail
    // closed). The core is pure, so the operator-visible signal for that typo lives here — for
    // rules that actually bind THIS evaluation, once each.
    for (const r of new Set(matched)) {
      if (
        r.jurisdiction === "STATE" &&
        r.states.some((x) => x.trim() !== "") &&
        ruleStates(r).length === 0
      ) {
        this.logger.warn(
          `SellingRestriction ${r.id} (tenant ${tenantId}) has an unreadable state entry; it blocks everywhere until corrected`,
        );
      }
    }
    let governingState = UNRESOLVED_STATE;
    if (anyRuleNeedsState(matched) && customerId) {
      // Ownership check + addresses in ONE query through the customer: a nested select is not
      // rewritten by the tenant extension, so a legacy address row with a NULL tenantId is still
      // seen (dropping it could let a different, stamped address govern), and a customer that
      // isn't this tenant's yields no addresses → UNRESOLVED.
      const customer = await db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: {
          addresses: {
            select: { isDefault: true, addressType: true, stateCode: true, stateNeedsReview: true },
          },
        },
      });
      governingState = customer
        ? resolveGoverningState(customer.addresses, policy.addressPrecedence)
        : UNRESOLVED_STATE;
    }

    const ruleCategoryIds = [
      ...new Set(matched.map((r) => r.categoryId).filter(Boolean)),
    ] as string[];
    const categoryNames = new Map<string, string>();
    if (ruleCategoryIds.length > 0) {
      const cats = await db.productCategory.findMany({
        where: { tenantId, id: { in: ruleCategoryIds } },
        select: { id: true, name: true },
      });
      for (const c of cats) categoryNames.set(c.id, c.name);
    }

    return evaluateRestrictions({ channel, at, products, rules, governingState, categoryNames });
  }
}
