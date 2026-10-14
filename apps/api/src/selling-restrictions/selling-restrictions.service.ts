import { ConflictException, Injectable, Logger } from "@nestjs/common";
import type {
  BuyerBlockedLine,
  BuyerSellingRestrictedError,
  RestrictionAddressPrecedence,
  RestrictionChannel,
  RestrictionsEvaluation,
  RestrictionsPolicy,
  SellingRestrictedError,
} from "@routeflow/types";
import { assertAmbientTenant } from "../common/ambient-tenant";
import { normalizeUsState } from "../common/us-states";
import { excludeWalkIn } from "../customers/walk-in-protected";
import { PrismaService } from "../prisma/prisma.service";
import { tenantBusinessState } from "./tenant-business-state";
import { tenantIsPickupOnly, tenantOffersPickup } from "./tenant-fulfilment-model";
import { judgedAtStore, type SaleFulfilmentKind } from "./sale-fulfilment";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import {
  activeRuleWhere,
  buyerRestrictedSummary,
  checkableProductIds,
  evaluateRestrictions,
  matchingRules,
  offEvaluation,
  resolveGoverningState,
  restrictedSummary,
  restrictionsApply,
  ruleHidesFromBuyer,
  ruleMatchesProduct,
  ruleTargetSets,
  type RuleTargetRow,
  ruleStates,
  stateRuleInPlay,
  UNRESOLVED_STATE,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";
import { API_ERROR_CODES } from "../common/api-error-codes";

export interface EvaluateLine {
  productId: string;
}

/**
 * The two values the `selling_restrictions.enabled` switch stores — the settings step must write
 * EXACTLY these. `getPolicy` reads "false" (trimmed, any case) as OFF and every other stored value,
 * a typo included, as ON: an unreadable switch fails closed and never silently disables a ban.
 */
export const SELLING_RESTRICTIONS_ENABLED_VALUE = "true";
export const SELLING_RESTRICTIONS_DISABLED_VALUE = "false";

/** `ConflictException` code `assertReadyToEnable` throws while the tenant's data is not ready. */
export const SELLING_RESTRICTIONS_NOT_READY = API_ERROR_CODES.SELLING_RESTRICTIONS_NOT_READY;

/** Customers the enable-readiness probe reads per query (keeps a large tenant off one giant read). */
export const ENABLE_READINESS_PAGE_SIZE = 500;

/**
 * Upper bound on the probe's sweep (pages). A tenant bigger than PAGE_SIZE × MAX_PAGES customers
 * gets `truncated: true` and `ready: false` — a partial sweep must never read as green.
 */
export const ENABLE_READINESS_MAX_PAGES = 400;

/**
 * What flipping `selling_restrictions.enabled` ON would meet in this tenant's live (non-deleted)
 * customers. Buckets are independent tallies, not a partition — one customer can be counted in
 * several. `ready` is true only when NO customer's governing state would resolve UNRESOLVED (which
 * would make every order that meets a STATE rule INDETERMINATE, with no warning).
 */
export interface EnableReadiness {
  ready: boolean;
  /** true when the sweep hit ENABLE_READINESS_MAX_PAGES — the counts are partial and `ready` is false. */
  truncated: boolean;
  customerCount: number;
  /** Customers with zero addresses. */
  customersWithoutAddress: number;
  /** Customers with 2+ addresses and none flagged `isDefault` (no way to pick one). */
  customersAmbiguousNoDefault: number;
  /** Addresses with no USABLE state code — NULL, blank, or not a USPS code (`normalizeUsState` → null). */
  addressesMissingStateCode: number;
  /** Addresses flagged `stateNeedsReview`. */
  addressesNeedingReview: number;
  /** Customers `resolveGoverningState` (the engine's own) leaves UNRESOLVED under the tenant's precedence. */
  indeterminateCustomerCount: number;
  /**
   * True only when a business state is REQUIRED and absent: the tenant has at least one active STATE rule (one that
   * binds the staff channel and names a readable state) and no usable business-address state (Settings > Business).
   * A counter sale to the system walk-in is judged by that state, so without one every such rule is INDETERMINATE and
   * the tenant is not ready. With no STATE rule in play a missing business address is not a blocker: false.
   */
  businessStateMissing: boolean;
}

/** The `SellingRestriction` columns the decision reads (`RestrictionRuleFacts`). */
const RULE_FACTS_SELECT = {
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
} as const;

/** Row 509: the `SellingRestrictionTarget` columns the decision reads (`RuleTargetRow`). */
const TARGET_ROW_SELECT = {
  productId: true,
  categoryId: true,
  addedAt: true,
  removedAt: true,
} as const;

/** A rule row as the two product-matching loaders read it: its facts plus (some of) its target rows and their count. */
type RuleRowWithTargets = Omit<RestrictionRuleFacts, "targets"> & {
  targets?: RuleTargetRow[];
  _count?: { targets: number };
};

/**
 * Row 509: rule rows → facts with their target sets at `at`. A rule with no target rows at all keeps `targets: null`
 * (matched by its legacy column, SA condition 1); `_count` is the rule's FULL row count, so a loader may fetch only
 * the target rows that touch its products.
 */
function withTargetSets(rows: readonly RuleRowWithTargets[], at: Date): RestrictionRuleFacts[] {
  return rows.map(({ targets, _count, ...rule }) => {
    // A missing count would silently read as "no target rows" and fall back to the legacy column: fail loud.
    if (typeof _count?.targets !== "number" || !targets) {
      throw new Error(
        `selling restrictions: rule ${rule.id} was read without its targets and count`,
      );
    }
    return { ...rule, targets: ruleTargetSets(targets, _count.targets, at) };
  });
}

/** Row 509: a target row active at `at` (the SQL twin of `targetIsActive`; the core re-checks in JS). */
const activeTargetWhere = (at: Date) => ({
  addedAt: { lte: at },
  OR: [{ removedAt: null }, { removedAt: { gt: at } }],
});

/** Levels of variants under a rule's product the buyer visibility expansion follows (a malformed cycle's bound). */
const BUYER_VISIBILITY_MAX_DEPTH = 5;

/** The address columns the governing-state resolver reads. */
export const ADDRESS_SELECT = {
  isDefault: true,
  addressType: true,
  stateCode: true,
  stateNeedsReview: true,
} as const;

/**
 * One line a write path is about to put on an order/invoice. `qtyDelta` omitted = a NEW line
 * (always checked); a number is the net change in TOTAL SELLING UNITS (`boxes × unitsPerBox +
 * pieces`, as one plain JS number — never a per-field delta such as "pieces only"). Decisions are
 * per PRODUCT, not per line: a product whose lines' numeric deltas sum to `<= 0` (a decrease, a
 * removal, or a repack across lines) is NEVER checked (owner rule: a ban must never trap an
 * operator into keeping stock on an order); a product with ANY line whose delta is omitted,
 * non-numeric or NaN cannot be netted, so it is checked (fail closed).
 */
export interface SellableLine {
  productId: string;
  qtyDelta?: number;
}

export interface SellableLinesParams {
  tenantId: string;
  /**
   * Whose governing address decides. A change of customer or of the governing address is NOT a
   * line delta: a caller in that situation must re-send the whole line set with `qtyDelta` omitted
   * (a re-check of everything), or an all-decrease call would return ALLOW with no reads.
   */
  customerId: string | null;
  lines: readonly SellableLine[];
  /**
   * Who is selling: `restrictionChannelForPrincipal(user)`, or `"STAFF"` for a cron / system caller
   * with no principal. Omitted (a JS or `any` caller) FAILS CLOSED to BUYER_PORTAL — never STAFF.
   */
  channel: RestrictionChannel;
  at?: Date;
  /** As `EvaluateOptions.switchGated`. */
  switchGated?: boolean;
  /** As `EvaluateOptions.skipPortalOnlyRules`. */
  skipPortalOnlyRules?: boolean;
  /** As `EvaluateOptions.fulfilmentKind`: REQUIRED, so every caller states how the goods change hands. */
  fulfilmentKind: SaleFulfilmentKind;
}

export interface EvaluateOptions {
  /** As `SellableLinesParams.channel`: required, and an omitted value fails closed to BUYER_PORTAL. */
  channel: RestrictionChannel;
  /** Point-in-time evaluation; defaults to now. */
  at?: Date;
  /**
   * The tenant switch gates this call as it gates STAFF (off = OFF) whatever the channel. For STAFF-side
   * warnings that judge at the portal channel but must stay silent until the tenant turns restrictions on
   * (the merge warning), so a portal limit alone does not start raising operator alerts.
   */
  switchGated?: boolean;
  /**
   * Judge as the portal channel but ignore rules whose surface is BUYER_PORTAL: a portal limit asks to hide a product
   * from the buyer portal, not to block a staff-built order. A legal ban (surface ALL) still binds. For a standing
   * order of legacy provenance (a NULL creator/editor role beside known staff), which is staff-built.
   */
  skipPortalOnlyRules?: boolean;
  /**
   * L8: how the goods change hands (`sale-fulfilment.ts`), REQUIRED so no caller can forget to say. COUNTER / PICKUP
   * judge a STATE rule on the STORE's state for every customer, named or walk-in; DELIVERY keeps the customer's address.
   */
  fulfilmentKind: SaleFulfilmentKind;
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
 * `selling-restrictions.core.ts`. READ-ONLY; `evaluate()` never writes and never throws for a
 * business outcome — `assertLinesSellable()` (the step-2 choke point) turns BLOCK/INDETERMINATE
 * into the 409.
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
   *                                               Write `SELLING_RESTRICTIONS_ENABLED_VALUE` /
   *                                               `SELLING_RESTRICTIONS_DISABLED_VALUE`.
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
      enabled:
        enabled !== undefined &&
        enabled.trim().toLowerCase() !== SELLING_RESTRICTIONS_DISABLED_VALUE,
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

  /**
   * Enable-readiness probe: what turning `selling_restrictions.enabled` ON would meet in this
   * tenant's data. A governing state needs `CustomerAddress.stateCode`, which is NULL everywhere
   * until the owner-run normalize script has run — flipping the switch on an un-backfilled tenant
   * would make nearly every order that meets a STATE rule INDETERMINATE, with no warning.
   *
   * Counts with the SAME `resolveGoverningState` the engine uses, under the tenant's CURRENT
   * precedence policy (the switch itself is irrelevant here — this is asked before it flips).
   * Customers are read in cursor pages of `ENABLE_READINESS_PAGE_SIZE`, never in one query.
   * READ-ONLY, and never called from `evaluate()`: readiness is advice for the settings step, it
   * must not block an order.
   */
  async getEnableReadiness(tenantId: string): Promise<EnableReadiness> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService");
    const { addressPrecedence } = await this.getPolicy(tenantId);
    const db = this.prisma.forTenant();
    const businessStateMissing = await this.businessStateMissing(tenantId);

    const tally = {
      customerCount: 0,
      customersWithoutAddress: 0,
      customersAmbiguousNoDefault: 0,
      addressesMissingStateCode: 0,
      addressesNeedingReview: 0,
      indeterminateCustomerCount: 0,
    };
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    for (;;) {
      if (pages >= ENABLE_READINESS_MAX_PAGES) {
        truncated = true;
        break;
      }
      pages++;
      // Same shape as `evaluate`'s address read: the nested select is not rewritten by the tenant
      // extension, so a legacy address row with a NULL tenantId still counts as the customer's.
      const page = await db.customer.findMany({
        // The tenant's system walk-in customer has no address by design (counter sales to an
        // anonymous buyer), so it is excluded in SQL by the shared `isWalkIn` predicate — never by
        // name, and never counted as "missing an address".
        where: excludeWalkIn({ tenantId, deletedAt: null }),
        orderBy: { id: "asc" },
        take: ENABLE_READINESS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, addresses: { select: ADDRESS_SELECT } },
      });
      for (const customer of page) {
        const addresses = customer.addresses;
        tally.customerCount++;
        if (addresses.length === 0) tally.customersWithoutAddress++;
        else if (addresses.length >= 2 && !addresses.some((a) => a.isDefault)) {
          tally.customersAmbiguousNoDefault++;
        }
        for (const a of addresses) {
          if (normalizeUsState(a.stateCode) === null) tally.addressesMissingStateCode++;
          if (a.stateNeedsReview) tally.addressesNeedingReview++;
        }
        if (!resolveGoverningState(addresses, addressPrecedence).resolved) {
          tally.indeterminateCustomerCount++;
        }
      }
      if (page.length < ENABLE_READINESS_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return {
      ready: !truncated && tally.indeterminateCustomerCount === 0 && !businessStateMissing,
      truncated,
      ...tally,
      businessStateMissing,
    };
  }

  /**
   * True only when a business state is REQUIRED and absent. A business state matters only when some active STATE
   * rule could need it (the same `stateRuleInPlay` evaluate() asks, on the STAFF channel: an `ALL` legal-ban rule, or
   * on the portal channel of a PICKUP-ONLY tenant):
   * a tenant with no such rule (none, FEDERAL only, or only lifted / expired ones, or portal-only ones on a shipping tenant) never needs
   * one. The ONE answer for the readiness probe and the "customers without a state" card.
   */
  async businessStateMissing(tenantId: string, at: Date = new Date()): Promise<boolean> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService");
    const stateRules: RestrictionRuleFacts[] = await this.prisma
      .forTenant()
      .sellingRestriction.findMany({
        where: { tenantId, jurisdiction: "STATE", AND: [activeRuleWhere(at)] },
        select: RULE_FACTS_SELECT,
      });
    // L8 M1: a tenant WITH a pickup path (pickup-only or pickup+ship) judges that path by the store state, so a state
    // rule that binds the portal (any surface) needs one there as well. Read lazily: only when no staff rule already asks for it.
    const needed =
      stateRuleInPlay(stateRules, "STAFF", at) ||
      (stateRuleInPlay(stateRules, "BUYER_PORTAL", at) &&
        (await tenantOffersPickup(this.prisma, tenantId)));
    return needed && (await tenantBusinessState(this.prisma, tenantId)) === null;
  }

  /**
   * For the settings/enable endpoint (another lane's step): returns the readiness when the tenant
   * is ready, otherwise throws a 409 `{ code: "SELLING_RESTRICTIONS_NOT_READY", readiness }` so the
   * UI can show what to fix. Never called from `evaluate()` — orders never block on readiness.
   */
  async assertReadyToEnable(tenantId: string): Promise<EnableReadiness> {
    const readiness = await this.getEnableReadiness(tenantId);
    if (!readiness.ready) {
      throw new ConflictException({ code: SELLING_RESTRICTIONS_NOT_READY, readiness });
    }
    return readiness;
  }

  async evaluate(
    tenantId: string,
    customerId: string | null,
    lines: readonly EvaluateLine[],
    options: EvaluateOptions,
  ): Promise<RestrictionsEvaluation> {
    const policy = await this.getPolicy(tenantId);
    const channel = options?.channel ?? "BUYER_PORTAL"; // fail closed: the channel that binds more
    // The switch adds STAFF enforcement only: the portal channel always applies its rules (restrictionsApply).
    if (!restrictionsApply(policy, options?.switchGated ? "STAFF" : channel))
      return offEvaluation();

    const productIds = [...new Set(lines.map((l) => l.productId))];
    if (productIds.length === 0) return { outcome: "ALLOW", reasons: [] };

    const at = options?.at ?? new Date();
    const db = this.prisma.forTenant();

    // The switch is off and only the portal reaches here: a tenant that has set no limit at all is judged exactly
    // as before the portal ignored the switch (nothing to apply, no product reads). Switch ON never takes this exit,
    // so its fail-closed handling of an unresolvable product is unchanged.
    if (!restrictionsApply(policy, "STAFF")) {
      // (the staff channel applies only with the switch on, so this reads "the switch is off")
      const anyRule = await db.sellingRestriction.findMany({
        where: {
          tenantId,
          AND: [activeRuleWhere(at)],
          // a run that ignores portal-only limits must not be kept busy by one existing
          ...(options?.skipPortalOnlyRules ? { surface: { not: "BUYER_PORTAL" as const } } : {}),
        },
        select: { id: true },
        take: 1,
      });
      if (anyRule.length === 0) return { outcome: "ALLOW", reasons: [] };
    }

    const labels = await this.productLabels.effectiveLabels(tenantId, productIds);
    const products: ProductFacts[] = productIds.map((id) => {
      const l = labels.get(id);
      return {
        id,
        name: l?.name ?? id,
        effectiveCategoryIds: l?.effectiveCategoryIds ?? new Set<string>(),
        lineageIds: l?.lineageIds ?? new Set([id]),
        ...(l?.nameKnown ? { nameKnown: true } : {}),
        ...(l?.resolvable === false || !l ? { unresolvable: true } : {}),
      };
    });
    const categoryIds = new Set<string>();
    const lineageIds = new Set<string>();
    for (const p of products) {
      p.effectiveCategoryIds.forEach((c) => categoryIds.add(c));
      for (const id of p.lineageIds ?? new Set<string>()) lineageIds.add(id);
    }

    // Row 509: a rule touches these products through its legacy column OR any target row (the pure match below
    // decides with the ACTIVE targets; a rule with targets never matches by its legacy column).
    const touches = [
      { productId: { in: [...lineageIds] } },
      ...(categoryIds.size > 0 ? [{ categoryId: { in: [...categoryIds] } }] : []),
    ];
    const loadedRows: RuleRowWithTargets[] = await db.sellingRestriction.findMany({
      where: {
        tenantId,
        OR: [...touches, { targets: { some: { AND: [activeTargetWhere(at), { OR: touches }] } } }],
        // Only rules active at `at` (the SQL twin of `ruleIsActive`; `matchingRules` re-checks in JS).
        AND: [activeRuleWhere(at)],
      },
      // Belt-and-braces: the JS `compareRules` sort in `matchingRules` is what makes the cited rule
      // deterministic (a database collation's `id` order need not equal JS string order) — do NOT
      // drop that sort because this ordering exists.
      orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }],
      select: {
        ...RULE_FACTS_SELECT,
        targets: {
          where: { AND: [activeTargetWhere(at), { OR: touches }] },
          select: TARGET_ROW_SELECT,
        },
        _count: { select: { targets: true } },
      },
    });
    const loadedRules = withTargetSets(loadedRows, at);
    // A staff-built run ignores portal-only limits (a legal ban, surface ALL, still binds).
    const rules = options?.skipPortalOnlyRules
      ? loadedRules.filter((r) => (r.surface as string) !== "BUYER_PORTAL")
      : loadedRules;

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
    const stateInPlay = stateRuleInPlay(matched, channel, at); // asked ONCE (readiness asks the same)
    if (stateInPlay && judgedAtStore(options.fulfilmentKind)) {
      // L8: a counter sale / pickup is judged where the STORE is, whoever the customer is (or none). No usable store
      // state stays UNRESOLVED (INDETERMINATE, fail closed) — never the customer's address instead.
      const state = await tenantBusinessState(this.prisma, tenantId);
      governingState = state ? { resolved: true, state } : UNRESOLVED_STATE;
    } else if (stateInPlay && customerId) {
      // Ownership check + addresses in ONE query through the customer: a nested select is not
      // rewritten by the tenant extension, so a legacy address row with a NULL tenantId is still
      // seen (dropping it could let a different, stamped address govern), and a customer that
      // isn't this tenant's yields no addresses → UNRESOLVED.
      const customer = await db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: {
          isWalkIn: true,
          addresses: { select: ADDRESS_SELECT },
        },
      });
      if (customer?.isWalkIn === true) {
        // The tenant's system walk-in (the SYSTEM flag, never the name) has no address of its own: a counter sale is
        // judged where the store is. A walk-in's own address, if one is ever added, is intentionally ignored in
        // favour of the tenant state. No usable business state stays UNRESOLVED (INDETERMINATE), as before.
        const state = await tenantBusinessState(this.prisma, tenantId);
        governingState = state ? { resolved: true, state } : UNRESOLVED_STATE;
      } else {
        governingState = customer
          ? resolveGoverningState(customer.addresses, policy.addressPrecedence)
          : UNRESOLVED_STATE;
      }
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

    return evaluateRestrictions({
      channel,
      at,
      products,
      rules,
      governingState,
      categoryNames,
      storeJudged: judgedAtStore(options.fulfilmentKind),
    });
  }

  /**
   * The product ids the BUYER PORTAL must not show this customer: every product a rule active at `at` hides from them
   * (`ruleHidesFromBuyer`: BLOCK and INDETERMINATE both hide, a portal-only limit does not hide from a customer with no
   * state on file). Runs whatever the staff-enforcement switch says: portal limits always apply. ONE indexed query when
   * the tenant has no active rule (the common case), and nothing else is read.
   *
   * Parity with `evaluate()`: candidates are expanded from the hiding rules (a product rule: the product and its
   * variants; a category rule: the products labelled INCLUDE and their variants), then judged by the SAME pure
   * `ruleMatchesProduct` over `ProductLabelsService.effectiveLabels`, so an EXCLUDE opt-out keeps a variant visible and
   * a reparented variant is judged by its current parent. A candidate whose label chain cannot be resolved is hidden
   * (fail closed, as `evaluate` answers INDETERMINATE).
   */
  async restrictedProductIdsFor(
    tenantId: string,
    customerId: string | null,
    at: Date = new Date(),
  ): Promise<ReadonlySet<string>> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService");
    const db = this.prisma.forTenant();
    // Row 509: every active rule with its targets active at `at` (bounded by the per-rule cap the admin writes
    // enforce, SA condition 6) and its full row count (the zero-target legacy fallback).
    const rows: RuleRowWithTargets[] = await db.sellingRestriction.findMany({
      where: { tenantId, AND: [activeRuleWhere(at)] },
      select: {
        ...RULE_FACTS_SELECT,
        targets: { where: activeTargetWhere(at), select: TARGET_ROW_SELECT },
        _count: { select: { targets: true } },
      },
    });
    if (rows.length === 0) return new Set<string>();
    const rules = withTargetSets(rows, at);

    let governingState = UNRESOLVED_STATE;
    let judgedOnStore = false;
    if (stateRuleInPlay(rules, "BUYER_PORTAL", at)) {
      if (await tenantIsPickupOnly(this.prisma, tenantId)) {
        // L8 M1: buyers of a pickup-only tenant collect in store, so the portal hides by the STORE's state (no customer
        // needed); an unset store state stays UNRESOLVED and hides the restricted products (fail closed).
        judgedOnStore = true;
        const state = await tenantBusinessState(this.prisma, tenantId);
        governingState = state ? { resolved: true, state } : UNRESOLVED_STATE;
      } else if (customerId) {
        const { addressPrecedence } = await this.getPolicy(tenantId);
        const customer = await db.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { isWalkIn: true, addresses: { select: ADDRESS_SELECT } },
        });
        if (customer?.isWalkIn === true) {
          const state = await tenantBusinessState(this.prisma, tenantId);
          governingState = state ? { resolved: true, state } : UNRESOLVED_STATE;
        } else if (customer) {
          governingState = resolveGoverningState(customer.addresses, addressPrecedence);
        }
      }
    }
    const hiding = rules.filter((r) => ruleHidesFromBuyer(r, governingState, judgedOnStore));
    if (hiding.length === 0) return new Set<string>();

    // Candidates: the rules' own products and the products labelled with a hiding category, plus their variants.
    // Row 509: a rule's product / label targets, or its legacy column when it has no target rows.
    const seeds = new Set<string>();
    const hidingCategories = new Set<string>();
    for (const r of hiding) {
      if (r.targets) {
        r.targets.productIds.forEach((id) => seeds.add(id));
        r.targets.categoryIds.forEach((id) => hidingCategories.add(id));
      } else if (r.productId) seeds.add(r.productId);
      else if (r.categoryId) hidingCategories.add(r.categoryId);
    }
    const categoryIds = [...hidingCategories];
    if (categoryIds.length > 0) {
      const labelled = await db.productCategoryLabel.findMany({
        where: { tenantId, categoryId: { in: categoryIds }, mode: "INCLUDE" },
        select: { productId: true },
      });
      for (const l of labelled) seeds.add(l.productId);
    }
    const candidates = new Set<string>(seeds);
    let frontier = [...seeds];
    for (let depth = 0; depth < BUYER_VISIBILITY_MAX_DEPTH && frontier.length > 0; depth++) {
      const kids: Array<{ id: string }> = await db.product.findMany({
        where: { tenantId, parentProductId: { in: frontier } },
        select: { id: true },
      });
      frontier = kids.map((k) => k.id).filter((id) => !candidates.has(id));
      for (const id of frontier) candidates.add(id);
    }
    if (candidates.size === 0) return new Set<string>();

    const labels = await this.productLabels.effectiveLabels(tenantId, [...candidates]);
    const hidden = new Set<string>();
    for (const id of candidates) {
      const l = labels.get(id);
      if (!l || l.resolvable === false) {
        hidden.add(id); // unresolvable: fail closed
        continue;
      }
      const facts: ProductFacts = {
        id,
        name: l.name,
        effectiveCategoryIds: l.effectiveCategoryIds,
        lineageIds: l.lineageIds,
      };
      if (hiding.some((r) => ruleMatchesProduct(r, facts))) hidden.add(id);
    }
    return hidden;
  }

  /**
   * The choke point's read half (step 2): `evaluate()` over only the products that ADD sellable
   * quantity. Lines with no product id (nothing to check) are dropped, then the lines are grouped
   * by product: a product is checked when ANY of its lines has an omitted / non-numeric / NaN
   * `qtyDelta` (cannot be netted — fail closed) or when its numeric deltas sum to `> 0`;
   * decreases, removals and repacks (`sum <= 0`) are never checked. When nothing is left the
   * answer is ALLOW with NO reads at all. It NEVER returns OFF for that case — "is this tenant
   * gated?" is `getPolicy()`, not this method.
   */
  async checkLinesSellable(params: SellableLinesParams): Promise<RestrictionsEvaluation> {
    if (!params.tenantId) throw new Error("checkLinesSellable requires a tenantId");
    const checkable = checkableProductIds(params.lines);
    if (checkable.length === 0) return { outcome: "ALLOW", reasons: [] };
    return this.evaluate(
      params.tenantId,
      params.customerId,
      checkable.map((productId) => ({ productId })),
      {
        channel: params.channel,
        at: params.at,
        switchGated: params.switchGated,
        skipPortalOnlyRules: params.skipPortalOnlyRules,
        fulfilmentKind: params.fulfilmentKind,
      },
    );
  }

  /**
   * The choke point every line-writing path calls BEFORE it writes: BLOCK and INDETERMINATE
   * (fail closed) throw a structured 409 mirroring `REGULATED_AUTH_REQUIRED`'s shape; OFF and
   * ALLOW return. Read-only — a throw here leaves nothing mutated.
   *
   * The body is redacted BY AUDIENCE, HERE, where the exception is built (B612): only an explicit
   * `STAFF` channel gets the rule id, reason, state, category and rule text. Anything else — a
   * buyer, an omitted or unrecognised channel — gets `{ productId, productName }` lines (deduped,
   * so the number of rules per product is not disclosed either) and a sentence built from names.
   * The web UI happens to render only the names; the leak is in the payload, not the pixels.
   */
  async assertLinesSellable(params: SellableLinesParams): Promise<void> {
    const evaluation = await this.checkLinesSellable(params);
    if (evaluation.outcome !== "BLOCK" && evaluation.outcome !== "INDETERMINATE") return;
    // Same value the evaluation was judged on; only the literal "STAFF" is trusted with the detail.
    if (params.channel === "STAFF") {
      const body: SellingRestrictedError = {
        code: API_ERROR_CODES.SELLING_RESTRICTED,
        message: restrictedSummary(evaluation.reasons),
        blockedLines: evaluation.reasons,
      };
      throw new ConflictException(body);
    }
    const seen = new Set<string>();
    const blockedLines: BuyerBlockedLine[] = [];
    for (const r of evaluation.reasons) {
      if (seen.has(r.productId)) continue;
      seen.add(r.productId);
      blockedLines.push({ productId: r.productId, productName: r.productName });
    }
    const body: BuyerSellingRestrictedError = {
      code: API_ERROR_CODES.SELLING_RESTRICTED,
      message: buyerRestrictedSummary(blockedLines),
      blockedLines,
    };
    throw new ConflictException(body);
  }
}

/**
 * SA-606 WS6: a BUYER order naming a product the tenant hid from the portal is the EXISTING buyer 409 envelope with
 * `reason: "HIDDEN_FROM_PORTAL"` on the line (and only there: a state/ban reason stays staff-only). Built HERE, at the
 * one construction site, so the B612 redaction pin ("no other file builds a SELLING_RESTRICTED body") still holds.
 */
export function hiddenFromPortalRestriction(blockedLines: BuyerBlockedLine[]): ConflictException {
  const names = blockedLines.slice(0, 3).map((l) => `"${l.productName}"`);
  const body: BuyerSellingRestrictedError = {
    code: API_ERROR_CODES.SELLING_RESTRICTED,
    message:
      blockedLines.length === 1
        ? `${names[0]} isn't available for online ordering.`
        : `${blockedLines.length} items on this order aren't available for online ordering: ${names.join(", ")}${
            blockedLines.length > 3 ? ` and ${blockedLines.length - 3} more` : ""
          }.`,
    blockedLines,
  };
  return new ConflictException(body);
}
