/**
 * Selling restrictions (lane R step 1) — the PURE decision core. No Prisma client, no Nest, no
 * clock (the one Prisma import is type-only, shaping `activeRuleWhere`): `SellingRestrictionsService`
 * loads the facts and hands them in, so every outcome below is unit-testable without a database.
 *
 * Three outcomes never share a code path (owner ruling):
 *   OFF            — the tenant switch is off. Nothing is read or evaluated (see `offEvaluation`).
 *   ALLOW / BLOCK  — switch on, the governing state (if a rule needs it) is known.
 *   INDETERMINATE  — switch on, a STATE rule matches a line, but the customer's state can't be
 *                    resolved (no address / unnormalised state). Fail closed: block + explain.
 * INDETERMINATE arises ONLY when a non-empty STATE rule matches a line — a customer with no
 * address can still buy a product no rule touches, and a FEDERAL rule blocks without consulting
 * the address at all.
 */

import type { Prisma } from "@prisma/client";
import type {
  BlockedLine,
  RestrictionAddressPrecedence,
  RestrictionChannel,
  RestrictionsEvaluation,
  RestrictionsPolicy,
} from "@routeflow/types";
import { normalizeUsState } from "../common/us-states";

/** A `SellingRestriction` row, reduced to what the decision reads. */
export interface RestrictionRuleFacts {
  id: string;
  categoryId: string | null;
  productId: string | null;
  jurisdiction: "FEDERAL" | "STATE";
  states: string[];
  surface: "ALL" | "BUYER_PORTAL";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  liftedAt: Date | null;
  reason: string;
  /**
   * Row 509: what the rule covers, from its ACTIVE `SellingRestrictionTarget` rows at the evaluation time. `null` /
   * absent = the rule has NO target rows at all (written before the targets table, or by old code during a deploy):
   * it is matched by its legacy `categoryId` / `productId` (SA condition 1, fail closed). A rule WITH target rows is
   * matched by them only, so an empty set (every target removed) matches nothing.
   */
  targets?: RuleTargetSets | null;
}

/** Row 509: a rule's active targets, split by kind (product targets bind lineage, label targets effective labels). */
export interface RuleTargetSets {
  productIds: ReadonlySet<string>;
  categoryIds: ReadonlySet<string>;
}

/** A `SellingRestrictionTarget` row, reduced to what the decision reads. */
export interface RuleTargetRow {
  productId: string | null;
  categoryId: string | null;
  addedAt: Date;
  removedAt: Date | null;
}

/** A target row is active at `at`: added on/before it and not yet removed (the same half-open window as a rule). */
export function targetIsActive(t: Pick<RuleTargetRow, "addedAt" | "removedAt">, at: Date): boolean {
  return (
    t.addedAt.getTime() <= at.getTime() &&
    (t.removedAt === null || t.removedAt.getTime() > at.getTime())
  );
}

/**
 * Row 509: the target sets a rule is matched by at `at`, or `null` when the rule has no target rows at all
 * (`totalRows === 0`: the legacy-column fallback, SA condition 1). `rows` may be a filtered subset of the rule's
 * rows (a loader that only fetched the ones touching its products); `totalRows` must be the rule's full count.
 */
export function ruleTargetSets(
  rows: readonly RuleTargetRow[],
  totalRows: number,
  at: Date,
): RuleTargetSets | null {
  if (totalRows === 0) return null;
  const productIds = new Set<string>();
  const categoryIds = new Set<string>();
  for (const t of rows) {
    if (!targetIsActive(t, at)) continue;
    if (t.productId) productIds.add(t.productId);
    else if (t.categoryId) categoryIds.add(t.categoryId);
  }
  return { productIds, categoryIds };
}

export interface CustomerAddressFacts {
  isDefault: boolean;
  addressType: string;
  stateCode: string | null;
  stateNeedsReview: boolean;
}

/** A line's product with its EFFECTIVE label set already computed. */
export interface ProductFacts {
  id: string;
  name: string;
  effectiveCategoryIds: ReadonlySet<string>;
  /**
   * The product's own id plus every ancestor id (variant → parent → …). A product-scoped rule on
   * a parent binds its variants — orders are placed against the variant rows. Defaults to just
   * the product's own id.
   */
  lineageIds?: ReadonlySet<string>;
  /**
   * The product (or an ancestor) could not be resolved in this tenant, so its label set is
   * unknown. Fail closed: INDETERMINATE, never a silent "no labels ⇒ allowed".
   */
  unresolvable?: boolean;
  /**
   * The product's OWN row was found, so `name` is a real product name (only an ancestor could not
   * be resolved). False/absent ⇒ `name` is the raw id and must never reach a buyer.
   */
  nameKnown?: boolean;
}

export type GoverningState = { resolved: true; state: string } | { resolved: false };

export const UNRESOLVED_STATE: GoverningState = { resolved: false };

/** `productName` of an UNKNOWN_PRODUCT reason — buyer-visible, so never a raw id. */
export const UNKNOWN_PRODUCT_NAME = "Unknown product";

/** The two fields of an authenticated principal the channel is read from. */
export interface ChannelPrincipal {
  /** Tenant users (`JwtPayload.role`); the buyer-portal principal carries NONE. */
  role?: string | null;
  /** `"BUYER"` on the buyer-portal principal (`BuyerJwtStrategy`); absent on tenant users. */
  type?: string | null;
}

/** Roles that positively sell as staff. Compared as strings so the core stays free of Prisma. */
const STAFF_ROLES: ReadonlySet<string> = new Set([
  "SUPER_ADMIN",
  "TENANT_ADMIN",
  "OPERATOR",
  "DRIVER",
]);

/**
 * The channel a PRINCIPAL sells through — and it FAILS CLOSED. STAFF only for a principal that is
 * positively staff: a known staff `role` and no buyer marker. Everything else is BUYER_PORTAL,
 * which binds a superset of the rules (ALL + BUYER_PORTAL): the buyer-portal principal (`type:
 * "BUYER"`, which carries no `role` at all), the CUSTOMER role, a hybrid carrying either marker,
 * an unknown role, no principal. A misclassified caller is over-blocked, never let through.
 * A system caller with no principal passes `"STAFF"` ONLY when the sale is genuinely
 * staff-originated; background work that materialises a BUYER's order (a standing-order cron, a
 * consolidation sweep) passes `"BUYER_PORTAL"`. The spec pins every `UserRole` value so a NEW role
 * must be classified on purpose.
 */
export function restrictionChannelForPrincipal(
  principal: ChannelPrincipal | null | undefined,
): RestrictionChannel {
  if (!principal || principal.type === "BUYER") return "BUYER_PORTAL";
  return principal.role != null && STAFF_ROLES.has(principal.role) ? "STAFF" : "BUYER_PORTAL";
}

/**
 * The ONE gate of the tenant switch (`selling_restrictions.enabled`): it adds STAFF enforcement only. The buyer-portal
 * channel ALWAYS applies its rules, so a portal limit works the moment the admin sets it; staff-channel blocking touches
 * orders, invoices, recurring jobs and imports, so it stays opt-in. Any channel that is not exactly "STAFF" is judged as
 * the portal (fail closed, like `restrictionChannelForPrincipal`). Every short-circuit on the switch calls this, never
 * `policy.enabled` directly (`portal-limits-pins.spec.ts`).
 */
export function restrictionsApply(
  policy: Pick<RestrictionsPolicy, "enabled">,
  channel: RestrictionChannel,
): boolean {
  return (channel as string) !== "STAFF" || policy.enabled;
}

/** The OFF outcome: a first-class result, produced without reading anything else. */
export function offEvaluation(): RestrictionsEvaluation {
  return { outcome: "OFF", reasons: [] };
}

/** Product names the 409 summary lists before "and N more"; the per-line detail stays in `blockedLines`. */
const SUMMARY_NAMES = 3;

/**
 * The one human sentence a client shows when it has no blocked-lines panel of its own (the web
 * handler toasts `body.message`; without one it shows "Request failed with status code 409"). A
 * lone line is its own message; several are summarised by product name.
 */
export function restrictedSummary(lines: readonly BlockedLine[]): string {
  if (lines.length === 0) return "This order can't be sold to this customer.";
  if (lines.length === 1) return lines[0].message;
  const names = lines.slice(0, SUMMARY_NAMES).map((l) => `"${l.productName}"`);
  const more = lines.length - names.length;
  return `${lines.length} products on this order can't be sold to this customer: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/**
 * The one sentence a BUYER-channel 409 carries (B612). Built from product NAMES only — never from a
 * line's own `message`, which quotes the rule (its admin-entered reason, the state). One product is
 * named; several are counted and the first few named; none falls back to a generic line.
 */
export function buyerRestrictedSummary(lines: readonly { productName: string }[]): string {
  if (lines.length === 0) return "Some items on this order can't be ordered right now.";
  if (lines.length === 1) return `"${lines[0].productName}" can't be ordered right now.`;
  const names = lines.slice(0, SUMMARY_NAMES).map((l) => `"${l.productName}"`);
  const more = lines.length - names.length;
  return `${lines.length} items on this order can't be ordered right now: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/**
 * A rule is active at `at` when inside its [effectiveFrom, effectiveTo) window and not lifted.
 * Lifting stamps `liftedAt` (and closes `effectiveTo`); a lift dated after `at` doesn't
 * retroactively deactivate the rule for a point-in-time check.
 *
 * Takes only the three window fields so any lane (the write side, the product-list chip, reports)
 * can reuse it on its own row type. `activeRuleWhere` is its SQL twin — keep the two in lock step
 * (pinned against each other by `selling-restrictions.core.spec.ts`).
 */
export function ruleIsActive(
  rule: Pick<RestrictionRuleFacts, "effectiveFrom" | "effectiveTo" | "liftedAt">,
  at: Date,
): boolean {
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  if (rule.effectiveTo && rule.effectiveTo.getTime() <= at.getTime()) return false;
  if (rule.liftedAt && rule.liftedAt.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * The SQL twin of `ruleIsActive`: a Prisma `SellingRestriction` `where` fragment selecting exactly
 * the rows active at `at` — effectiveFrom <= at AND (effectiveTo IS NULL OR effectiveTo > at) AND
 * (liftedAt IS NULL OR liftedAt > at). Compose it with `AND: [activeRuleWhere(at), …]` — it uses
 * the top-level `effectiveFrom` and `AND` keys, so never spread it next to your own `AND`.
 */
export function activeRuleWhere(at: Date) {
  return {
    effectiveFrom: { lte: at },
    AND: [
      { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
      { OR: [{ liftedAt: null }, { liftedAt: { gt: at } }] },
    ],
  } satisfies Prisma.SellingRestrictionWhereInput;
}

/**
 * Only an explicit `BUYER_PORTAL` surface is limited to the self-serve portal; ANY other value
 * (`ALL`, or one a newer schema adds before this file learns it) binds every channel. Fail closed:
 * an unknown surface must never quietly exempt the staff channel.
 */
export function ruleBindsChannel(
  rule: Pick<RestrictionRuleFacts, "surface">,
  channel: RestrictionChannel,
): boolean {
  return (rule.surface as string) !== "BUYER_PORTAL" || channel === "BUYER_PORTAL";
}

/**
 * Rule matches a product directly (a product target, through lineage: a parent's rule binds its variants) or
 * through any effective label (a label target). Row 509: a rule with target rows is matched by its ACTIVE targets
 * only; a rule with none falls back to its legacy `productId` / `categoryId` (SA condition 1).
 */
export function ruleMatchesProduct(rule: RestrictionRuleFacts, product: ProductFacts): boolean {
  const lineage = product.lineageIds ?? new Set([product.id]);
  if (rule.targets) {
    for (const id of lineage) if (rule.targets.productIds.has(id)) return true;
    for (const c of rule.targets.categoryIds) if (product.effectiveCategoryIds.has(c)) return true;
    return false;
  }
  if (rule.productId) return lineage.has(rule.productId);
  if (rule.categoryId) return product.effectiveCategoryIds.has(rule.categoryId);
  return false; // XOR CHECK in the DB makes this unreachable; never match on a malformed row.
}

/**
 * The TOTAL order every rule pick uses: newest `effectiveFrom` first, ties broken by `id`
 * ascending. The service's `findMany` asks the DB for the same order (`orderBy`), and
 * `matchingRules` re-applies it, so the rule a reason CITES never depends on the order rows came
 * back in.
 */
export function compareRules(
  a: Pick<RestrictionRuleFacts, "effectiveFrom" | "id">,
  b: Pick<RestrictionRuleFacts, "effectiveFrom" | "id">,
): number {
  const byFrom = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  if (byFrom !== 0) return byFrom;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The active, channel-binding rules that touch a product, in `compareRules` order — so the
 * `.find(...)` picks in `evaluateRestrictions` (federal / unrecognised / empty-states / state-hit)
 * cite the same rule for the same rule set, whatever order the caller loaded it in.
 */
export function matchingRules(
  rules: readonly RestrictionRuleFacts[],
  product: ProductFacts,
  channel: RestrictionChannel,
  at: Date,
): RestrictionRuleFacts[] {
  return rules
    .filter(
      (r) => ruleIsActive(r, at) && ruleBindsChannel(r, channel) && ruleMatchesProduct(r, product),
    )
    .sort(compareRules);
}

/**
 * A rule's USPS codes via `normalizeUsState` (so "tx", " TX " and "Texas" all mean TX); blank
 * entries are dropped. Any entry that is NOT a state ("Tex", "TX, OK", "N.Y.") makes the whole
 * rule MALFORMED — returned as `[]`, which the decision treats as "blocks everywhere": a rule
 * that names a place we cannot read must never silently block nowhere (fail closed).
 */
export function ruleStates(rule: RestrictionRuleFacts): string[] {
  const codes = rule.states.filter((s) => s.trim() !== "").map((s) => normalizeUsState(s));
  return codes.some((c) => c === null) ? [] : (codes as string[]);
}

/**
 * The ONE answer to "is a state needed?": some rule that is ACTIVE at `at`, binds `channel`, and is a STATE rule with at
 * least one readable state. A FEDERAL rule, a lifted / expired / not-yet-effective rule, a rule for another channel and a
 * malformed (blocks-everywhere) STATE rule never need one. `evaluate()` asks it of the rules that match the lines (so the
 * adapter loads addresses, or the tenant's business state for the walk-in) and the readiness probe asks it of every
 * active STATE rule of the tenant (so the business state is required ONLY when such a rule exists): one function, so the
 * two can never disagree about what "needs a state" means.
 */
export function stateRuleInPlay(
  rules: readonly RestrictionRuleFacts[],
  channel: RestrictionChannel,
  at: Date,
): boolean {
  return rules.some(
    (r) =>
      r.jurisdiction === "STATE" &&
      ruleIsActive(r, at) &&
      ruleBindsChannel(r, channel) &&
      ruleStates(r).length > 0,
  );
}

type AddressKind = "BILLING" | "SHIPPING" | "UNKNOWN";
/** `addressType` is an unvalidated free-text column on create, so classify explicitly. */
function addressKind(a: CustomerAddressFacts): AddressKind {
  const t = (a.addressType ?? "").trim().toUpperCase();
  if (t === "BILLING") return "BILLING";
  if (t === "SHIPPING" || t === "DELIVERY") return "SHIPPING";
  return "UNKNOWN";
}

/**
 * The address group `resolveGoverningState` reads (the selection half of D4, below): the preferred
 * type's defaults, else the other defaults, else the only address; empty when none can be chosen
 * (no address, several and no default, or an UNKNOWN-typed default among several). Exported so the
 * "customers without a state" buckets name the SAME addresses the engine reads, never a second rule.
 */
export function governingAddresses<A extends CustomerAddressFacts>(
  addresses: readonly A[],
  precedence: RestrictionAddressPrecedence,
): readonly A[] {
  const preferred: AddressKind = precedence === "SHIPPING_FIRST" ? "SHIPPING" : "BILLING";
  const defaults = addresses.filter((a) => a.isDefault);
  if (defaults.length === 0) return addresses.length === 1 ? addresses : [];
  if (defaults.length > 1 && defaults.some((a) => addressKind(a) === "UNKNOWN")) return [];
  const preferredDefaults = defaults.filter((a) => addressKind(a) === preferred);
  return preferredDefaults.length > 0 ? preferredDefaults : defaults;
}

/**
 * The customer's governing state (D4): their DEFAULT address. Only `isDefault` rows ever govern —
 * a non-default address never outranks the real default, whatever its type. The tenant's
 * billing/shipping precedence only chooses between DEFAULTS of different types: the preferred
 * type's default(s) if there are any, else the other type's default(s). With no default at all, a
 * customer with exactly one address is governed by it (PC-lead ruling: unambiguous); zero addresses,
 * or several and no default, is UNRESOLVED (fail closed). An UNKNOWN-typed default alongside other defaults can't be ordered, so it
 * is UNRESOLVED too. Every address in the chosen group must carry the same usable state code
 * (several defaults that disagree, or one flagged for review / with no or an unknown code, are
 * UNRESOLVED) — INDETERMINATE downstream.
 */
export function resolveGoverningState(
  addresses: readonly CustomerAddressFacts[],
  precedence: RestrictionAddressPrecedence,
): GoverningState {
  const group = governingAddresses(addresses, precedence);
  if (group.length === 0) return UNRESOLVED_STATE;

  const codes = new Set<string>();
  for (const a of group) {
    const code = normalizeUsState(a.stateCode);
    if (a.stateNeedsReview || code === null) return UNRESOLVED_STATE;
    codes.add(code);
  }
  return codes.size === 1 ? { resolved: true, state: [...codes][0] } : UNRESOLVED_STATE;
}

/**
 * Does this rule HIDE its products from a portal buyer in `governingState`? One predicate for the visibility engine
 * (`restrictedProductIdsFor`), matching `evaluateRestrictions` rule by rule: a federal, unrecognised or malformed
 * (no readable states) rule hides everywhere; a STATE rule hides when the buyer's state is named; and with the state
 * unresolved a legal ban (surface ALL, INDETERMINATE) hides while a portal-only limit does not (ALLOW). BLOCK and
 * INDETERMINATE both hide, so a legal-ban product is never shown and then refused at checkout. The caller loads only
 * rules ACTIVE at `at`; every active rule binds the portal channel.
 */
export function ruleHidesFromBuyer(
  rule: RestrictionRuleFacts,
  governingState: GoverningState,
): boolean {
  if ((rule.jurisdiction as string) !== "STATE") return true;
  const states = ruleStates(rule);
  if (states.length === 0) return true;
  if (!governingState.resolved) return (rule.surface as string) !== "BUYER_PORTAL";
  return states.includes(governingState.state);
}

export interface EvaluateInput {
  channel: RestrictionChannel;
  at: Date;
  products: readonly ProductFacts[];
  rules: readonly RestrictionRuleFacts[];
  governingState: GoverningState;
  /** categoryId → display name, for messages. */
  categoryNames?: ReadonlyMap<string, string>;
}

/** Decision for the switch-ON case. (OFF never reaches here — see `offEvaluation`.) */
export function evaluateRestrictions(input: EvaluateInput): RestrictionsEvaluation {
  const reasons: BlockedLine[] = [];
  let blocked = false;
  let indeterminate = false;

  for (const product of input.products) {
    if (product.unresolvable) {
      indeterminate = true;
      // The buyer sees this text. When the product's own row was not found its only "name" is the
      // raw id, so never echo `product.name` (or the id) — `productId` carries it. When only an
      // ANCESTOR is missing the real name is safe and lets the operator find the line.
      reasons.push(
        product.nameKnown
          ? {
              productId: product.id,
              productName: product.name,
              ruleId: null,
              reason: "UNKNOWN_PRODUCT",
              message: `"${product.name}" can't be checked against selling restrictions — one of its parent products could not be found.`,
            }
          : {
              productId: product.id,
              productName: UNKNOWN_PRODUCT_NAME,
              ruleId: null,
              reason: "UNKNOWN_PRODUCT",
              message:
                "A product on this order can't be checked against selling restrictions — the product or its parent could not be found.",
            },
      );
      continue;
    }
    const matched = matchingRules(input.rules, product, input.channel, input.at);
    if (matched.length === 0) continue;

    const line = (
      rule: RestrictionRuleFacts,
      reason: BlockedLine["reason"],
      message: string,
      state?: string,
    ): BlockedLine => ({
      productId: product.id,
      productName: product.name,
      categoryName: rule.categoryId ? input.categoryNames?.get(rule.categoryId) : undefined,
      ruleId: rule.id,
      reason,
      ...(state ? { state } : {}),
      message,
    });
    const banReason = (rule: RestrictionRuleFacts, kind: "FEDERAL_BAN" | "STATE_BAN") =>
      rule.surface === "BUYER_PORTAL" ? "BUYER_PORTAL_ONLY" : kind;

    const federal = matched.find((r) => r.jurisdiction === "FEDERAL");
    if (federal) {
      blocked = true;
      reasons.push(
        line(
          federal,
          banReason(federal, "FEDERAL_BAN"),
          `"${product.name}" can't be sold: restricted federally (${federal.reason}).`,
        ),
      );
      continue;
    }

    // Fail closed on enum extension: a matched rule whose jurisdiction is neither FEDERAL nor
    // STATE (a value added to the DB enum before this file learns it) blocks rather than falls
    // through to ALLOW.
    const unrecognised = matched.find(
      (r) => (r.jurisdiction as string) !== "FEDERAL" && (r.jurisdiction as string) !== "STATE",
    );
    if (unrecognised) {
      blocked = true;
      reasons.push(
        line(
          unrecognised,
          banReason(unrecognised, "STATE_BAN"),
          `"${product.name}" can't be sold: restricted (${unrecognised.reason}).`,
        ),
      );
      continue;
    }

    // A STATE rule with no states is malformed; it blocks everywhere (fail closed, plan §2.3).
    const stateRules = matched.filter((r) => r.jurisdiction === "STATE");
    const everywhere = stateRules.find((r) => ruleStates(r).length === 0);
    if (everywhere) {
      blocked = true;
      reasons.push(
        line(
          everywhere,
          banReason(everywhere, "STATE_BAN"),
          `"${product.name}" can't be sold: restricted (${everywhere.reason}).`,
        ),
      );
      continue;
    }

    if (!input.governingState.resolved) {
      // Owner ruling 2: a customer with no state on file is ALLOWED where every matched STATE rule is a portal-only limit
      // (a commercial choice, not law). A legal ban (surface ALL) among them keeps the fail-closed INDETERMINATE.
      if (stateRules.every((r) => (r.surface as string) === "BUYER_PORTAL")) continue;
      indeterminate = true;
      reasons.push(
        line(
          stateRules[0],
          "INDETERMINATE_ADDRESS",
          `"${product.name}" is restricted in some states and this customer's state can't be determined — add or correct the customer's address.`,
        ),
      );
      continue;
    }

    const state = input.governingState.state;
    const hit = stateRules.find((r) => ruleStates(r).includes(state));
    if (hit) {
      blocked = true;
      reasons.push(
        line(
          hit,
          banReason(hit, "STATE_BAN"),
          `"${product.name}" can't be sold to a customer in ${state}: ${hit.reason}.`,
          state,
        ),
      );
    }
  }

  // BLOCK outranks INDETERMINATE: a line that is definitely banned makes the answer "no" no
  // matter what the address turns out to be; both lines still appear in `reasons`.
  const outcome = blocked ? "BLOCK" : indeterminate ? "INDETERMINATE" : "ALLOW";
  return { outcome, reasons };
}

/**
 * The products of an order's lines that the choke point CHECKS, netted per PRODUCT (see
 * `SellingRestrictionsService.checkLinesSellable`): lines with no product id are dropped; a product is
 * checked when ANY of its lines has an omitted / non-numeric / NaN `qtyDelta` (cannot be netted, so
 * fail closed) or when its numeric deltas sum to `> 0`; decreases, removals and repacks are not.
 * One rule for the choke point AND for the order-edit re-check under the row lock.
 */
export function checkableProductIds(
  lines: ReadonlyArray<{ productId?: string | null; qtyDelta?: number }>,
): string[] {
  const byProduct = new Map<string, { undetermined: boolean; net: number }>();
  for (const l of lines) {
    if (!l.productId) continue;
    const agg = byProduct.get(l.productId) ?? { undetermined: false, net: 0 };
    if (typeof l.qtyDelta === "number" && !Number.isNaN(l.qtyDelta)) agg.net += l.qtyDelta;
    else agg.undetermined = true;
    byProduct.set(l.productId, agg);
  }
  // `!(net <= 0)` rather than `net > 0`: a NaN sum (e.g. -Infinity + Infinity) must stay checked.
  return [...byProduct].filter(([, a]) => a.undetermined || !(a.net <= 0)).map(([id]) => id);
}
