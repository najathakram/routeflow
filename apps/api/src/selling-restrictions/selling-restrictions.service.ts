import { ConflictException, Injectable, Logger } from "@nestjs/common";
import type {
  BlockedLine,
  BuyerBlockedLine,
  RestrictionWarningLine,
  BuyerSellingRestrictedError,
  RestrictionAck,
  RestrictionAddressPrecedence,
  RestrictionChannel,
  RestrictionsEvaluation,
  RestrictionsPolicy,
  SellingRestrictedError,
} from "@routeflow/types";
import { assertAmbientTenant } from "../common/ambient-tenant";
import { PrismaService } from "../prisma/prisma.service";
import { tenantBusinessState } from "./tenant-business-state";
import { tenantIsPickupOnly, tenantOffersPickup } from "./tenant-fulfilment-model";
import { judgedAtStore, type JurisdictionBasis, type SaleFulfilmentKind } from "./sale-fulfilment";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import {
  decideStaffWrite,
  noRestrictionOverride,
  type GateLine,
  type HeldLine,
  type StaffJudgement,
  type StaffWriteDecision,
  type StampTarget,
} from "./restriction-warning";
import { staffBreaches } from "./staff-breaches";
import {
  activeRuleWhere,
  buyerRestrictedSummary,
  checkableProductIds,
  evaluateRestrictions,
  matchingRules,
  resolveGoverningState,
  restrictedSummary,
  ruleHidesFromBuyer,
  ruleMatchesProduct,
  ruleTargetSets,
  type RuleTargetRow,
  ruleStates,
  stateRuleInPlay,
  UNRESOLVED_STATE,
  type ChannelPrincipal,
  type EvaluateInput,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";
import { API_ERROR_CODES } from "../common/api-error-codes";

export interface EvaluateLine {
  productId: string;
}

/** Customers the unknown-state sweep reads per query (keeps a large tenant off one giant read). */
export const ENABLE_READINESS_PAGE_SIZE = 500;

/**
 * Upper bound on the unknown-state sweep (pages). A tenant bigger than PAGE_SIZE x MAX_PAGES customers
 * gets `truncated: true` — a partial sweep must never read as complete.
 */
export const ENABLE_READINESS_MAX_PAGES = 400;

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
  /** Row 510: the line's stable key in a RESTRICTION_WARNING ("n:<i>" / "l:<lineId>" / "cr:<id>"); omitted = not warnable. */
  lineKey?: string;
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
  /** As `EvaluateOptions.skipPortalOnlyRules`. */
  skipPortalOnlyRules?: boolean;
  /** As `EvaluateOptions.fulfilmentKind`: REQUIRED, so every caller states how the goods change hands. */
  fulfilmentKind: SaleFulfilmentKind;
  /**
   * Row 510, STAFF channel only: who is selling, the acknowledgement the client sent, and the document's lines already
   * held (for coverage). With `principal` omitted (a system caller) a breach is a hard block, never a warning.
   */
  principal?: (ChannelPrincipal & { sub?: string | null }) | null;
  ack?: RestrictionAck | null;
  held?: readonly HeldLine[];
  /** Whose lines a stamp lands on (`decision.stamp(tx, parentId)`): an order's or an invoice's. */
  document?: "ORDER" | "INVOICE";
}

/**
 * What a row-510 gate builder returns: the choke point's parameters WITHOUT the channel. The call site states its own
 * channel (`channel-required.spec.ts` demands an explicit `channel:` on every call), so a builder can never decide it.
 */
export type SellableLinesArgs = Omit<SellableLinesParams, "channel">;

export interface EvaluateOptions {
  /** As `SellableLinesParams.channel`: required, and an omitted value fails closed to BUYER_PORTAL. */
  channel: RestrictionChannel;
  /** Point-in-time evaluation; defaults to now. */
  at?: Date;
  /**
   * L8: how the goods change hands (`sale-fulfilment.ts`), REQUIRED so no caller can forget to say. COUNTER / PICKUP
   * judge a STATE rule on the STORE's state for every customer, named or walk-in; DELIVERY keeps the customer's address.
   */
  fulfilmentKind: SaleFulfilmentKind;
  /**
   * Judge as the portal channel but ignore rules whose surface is BUYER_PORTAL: a portal limit asks to hide a product
   * from the buyer portal, not to block a staff-built order. A legal ban (surface ALL) still binds. For a standing
   * order of legacy provenance (a NULL creator/editor role beside known staff), which is staff-built.
   */
  skipPortalOnlyRules?: boolean;
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

/**
 * `SystemConfig` key for the tenant policy (plan §1.5). Row 510 removed the `selling_restrictions.enabled` switch: a
 * stored row of that name is simply never read.
 */
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
   * The tenant's policy, from one `SystemConfig` row (plan §1.5 — tenant-owned, so no new table):
   *   `selling_restrictions.governing_address` — "BILLING_FIRST" (default) | "SHIPPING_FIRST"; an
   *                                               unknown value parses to BILLING_FIRST with a warn.
   * Row 510: there is no on/off switch. Staff and buyer sales are always judged; a stored
   * `selling_restrictions.enabled` row is ignored (never read, never written). A DB error propagates.
   */
  async getPolicy(tenantId: string): Promise<RestrictionsPolicy> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService");
    const rows: Array<{ key: string; value: string }> = await this.prisma
      .forTenant()
      .systemConfig.findMany({
        where: { tenantId, key: SYSTEM_CONFIG_GOVERNING_ADDRESS },
        select: { key: true, value: true },
      });
    const value = (key: string) => rows.find((r) => r.key === key)?.value;
    return {
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
   * True only when a business state is REQUIRED and absent. A business state matters only when some active STATE
   * rule could need it (the same `stateRuleInPlay` evaluate() asks, on the STAFF channel: an `ALL` legal-ban rule, or
   * on the portal channel of a PICKUP-ONLY tenant):
   * a tenant with no such rule (none, FEDERAL only, or only lifted / expired ones, or portal-only ones on a shipping tenant) never needs
   * one. The ONE answer for the "customers without a state" card.
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

  async evaluate(
    tenantId: string,
    customerId: string | null,
    lines: readonly EvaluateLine[],
    options: EvaluateOptions,
  ): Promise<RestrictionsEvaluation> {
    return (await this.evaluateFacts(tenantId, customerId, lines, options)).evaluation;
  }

  /**
   * `evaluate` plus the facts it decided on (`input`), so a staff write can list EVERY breached rule
   * (`staffBreaches`) without a second read. `input` is null when nothing was decided (no product, no active rule).
   * Row 510: the tenant switch no longer gates ANY channel — a tenant with no active rule costs one indexed read.
   */
  private async evaluateFacts(
    tenantId: string,
    customerId: string | null,
    lines: readonly EvaluateLine[],
    options: EvaluateOptions,
  ): Promise<{
    evaluation: RestrictionsEvaluation;
    input: EvaluateInput | null;
    basis: JurisdictionBasis;
  }> {
    assertAmbientTenant(this.prisma, tenantId, "SellingRestrictionsService"); // before ANY read, as getPolicy did
    const channel = options?.channel ?? "BUYER_PORTAL"; // fail closed: the channel that binds more
    const storeJudged = judgedAtStore(options.fulfilmentKind);
    let basis: JurisdictionBasis = storeJudged ? "STORE" : "CUSTOMER";
    const allowed = { evaluation: { outcome: "ALLOW" as const, reasons: [] }, input: null, basis };

    const productIds = [...new Set(lines.map((l) => l.productId))];
    if (productIds.length === 0) return allowed;

    const at = options?.at ?? new Date();
    const db = this.prisma.forTenant();

    // A tenant that has set no rule at all is judged ALLOW after this one indexed read (row 510, Q6: the fast path is
    // unconditional, so a rule-less tenant never meets a warning, even for a product whose label chain cannot be read).
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
    if (anyRule.length === 0) return allowed;

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
    const stateInPlay = stateRuleInPlay(matched, channel, at); // asked ONCE (the no-state card asks the same)
    if (stateInPlay && storeJudged) {
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
        basis = "STORE";
        const state = await tenantBusinessState(this.prisma, tenantId);
        governingState = state ? { resolved: true, state } : UNRESOLVED_STATE;
      } else {
        const policy = await this.getPolicy(tenantId); // only the governing-address precedence is read from it
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

    const input: EvaluateInput = {
      channel,
      at,
      products,
      rules,
      governingState,
      categoryNames,
      storeJudged,
    };
    return { evaluation: evaluateRestrictions(input), input, basis };
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
        fulfilmentKind: params.fulfilmentKind,
        skipPortalOnlyRules: params.skipPortalOnlyRules,
      },
    );
  }

  /**
   * Row 510: the engine's verdict for a STAFF write, with EVERY breached rule listed (`staffBreaches`) and the basis the
   * sale was judged on. Wraps the same netting as `checkLinesSellable` (a decrease / removal / repack is never judged)
   * and, like it, never throws for a business outcome: `assertLinesSellable` decides what to do with it.
   */
  async judgeStaffWrite(params: SellableLinesParams): Promise<StaffJudgement> {
    if (!params.tenantId) throw new Error("judgeStaffWrite requires a tenantId");
    const checkable = checkableProductIds(params.lines);
    const basis: JurisdictionBasis = judgedAtStore(params.fulfilmentKind) ? "STORE" : "CUSTOMER";
    if (checkable.length === 0) return { outcome: "ALLOW", reasons: [], breaches: [], basis };
    const {
      evaluation,
      input,
      basis: judgedBasis,
    } = await this.evaluateFacts(
      params.tenantId,
      params.customerId,
      checkable.map((productId) => ({ productId })),
      {
        channel: params.channel,
        at: params.at,
        fulfilmentKind: params.fulfilmentKind,
        skipPortalOnlyRules: params.skipPortalOnlyRules,
      },
    );
    return {
      outcome: evaluation.outcome,
      reasons: evaluation.reasons,
      breaches: input ? staffBreaches(input) : [],
      basis: judgedBasis,
    };
  }

  /**
   * The choke point every line-writing path calls BEFORE it writes: BLOCK and INDETERMINATE
   * (fail closed) throw a structured 409 mirroring `REGULATED_AUTH_REQUIRED`'s shape; ALLOW
   * returns. Read-only — a throw here leaves nothing mutated.
   *
   * The body is redacted BY AUDIENCE, HERE, where the exception is built (B612): only an explicit
   * `STAFF` channel gets the rule id, reason, state, category and rule text. Anything else — a
   * buyer, an omitted or unrecognised channel — gets `{ productId, productName }` lines (deduped,
   * so the number of rules per product is not disclosed either) and a sentence built from names.
   * The web UI happens to render only the names; the leak is in the payload, not the pixels.
   *
   * Row 510: a STAFF breach no longer refuses outright when the principal may override. It resolves to the
   * `StaffWriteDecision` the caller stamps in its own transaction (`restriction-override-stamps.ts`), or throws the
   * 409 RESTRICTION_WARNING (`restriction-warning.ts`) the client acknowledges and resubmits. A principal who may not
   * override (DRIVER, SUPER_ADMIN) or a system caller with none (`principal` omitted) is still hard-blocked here.
   * Every other channel (a buyer) keeps the hard 409 and resolves to a no-op decision.
   */
  async assertLinesSellable(params: SellableLinesParams): Promise<StaffWriteDecision> {
    if (params.channel === "STAFF") {
      const judgement = await this.judgeStaffWrite(params);
      return decideStaffWrite({
        target: stampTargetOf(params),
        judgement,
        lines: params.lines.flatMap((l, i): GateLine[] => [
          { productId: l.productId, qtyDelta: l.qtyDelta, lineKey: l.lineKey ?? `n:${i}` },
        ]),
        held: params.held,
        principal: params.principal,
        ack: params.ack,
        customerId: params.customerId,
        blocked: staffRestrictedError,
      });
    }
    const evaluation = await this.checkLinesSellable(params);
    if (evaluation.outcome !== "BLOCK" && evaluation.outcome !== "INDETERMINATE")
      return noRestrictionOverride("CUSTOMER", stampTargetOf(params));
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

/** Where `decision.stamp` writes: the document kind, the tenant and the acting user (null for a system caller). */
function stampTargetOf(params: SellableLinesParams): StampTarget | null {
  return params.document
    ? {
        document: params.document,
        tenantId: params.tenantId,
        by: params.principal?.sub ?? null,
        impersonatedBy: params.principal?.impersonatedBy ?? null,
      }
    : null;
}

/**
 * The STAFF 409 SELLING_RESTRICTED (rule id, reason, state, category and rule text): the staff branch of
 * `assertLinesSellable` and the protocol's hard block for a principal who may not override. Built HERE with the buyer
 * body, at the one construction site (the B612 pin). `message` overrides the summary (the DRIVER's "ask the office").
 */
export function staffRestrictedError(
  reasons: BlockedLine[],
  message?: string,
  lines?: RestrictionWarningLine[],
): ConflictException {
  const body: SellingRestrictedError = {
    code: API_ERROR_CODES.SELLING_RESTRICTED,
    message: message ?? restrictedSummary(reasons),
    blockedLines: reasons,
    ...(lines && lines.length > 0 ? { lines } : {}),
  };
  return new ConflictException(body);
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
