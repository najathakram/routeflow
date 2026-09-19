/**
 * Selling restrictions (lane R step 1) — the PURE decision core. No Prisma, no Nest, no clock:
 * `SellingRestrictionsService` loads the facts and hands them in, so every outcome below is
 * unit-testable without a database.
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

import type {
  BlockedLine,
  RestrictionAddressPrecedence,
  RestrictionChannel,
  RestrictionsEvaluation,
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
}

export type GoverningState = { resolved: true; state: string } | { resolved: false };

export const UNRESOLVED_STATE: GoverningState = { resolved: false };

/** The OFF outcome: a first-class result, produced without reading anything else. */
export function offEvaluation(): RestrictionsEvaluation {
  return { outcome: "OFF", reasons: [] };
}

/**
 * A rule is active at `at` when inside its [effectiveFrom, effectiveTo) window and not lifted.
 * Lifting stamps `liftedAt` (and closes `effectiveTo`); a lift dated after `at` doesn't
 * retroactively deactivate the rule for a point-in-time check.
 */
export function ruleIsActive(rule: RestrictionRuleFacts, at: Date): boolean {
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  if (rule.effectiveTo && rule.effectiveTo.getTime() <= at.getTime()) return false;
  if (rule.liftedAt && rule.liftedAt.getTime() <= at.getTime()) return false;
  return true;
}

/** `ALL` rules bind every channel; `BUYER_PORTAL` rules bind only the self-serve portal. */
export function ruleBindsChannel(rule: RestrictionRuleFacts, channel: RestrictionChannel): boolean {
  return rule.surface === "ALL" || channel === "BUYER_PORTAL";
}

/** Rule matches a product directly (`productId`) or through any effective label (`categoryId`). */
export function ruleMatchesProduct(rule: RestrictionRuleFacts, product: ProductFacts): boolean {
  if (rule.productId) return (product.lineageIds ?? new Set([product.id])).has(rule.productId);
  if (rule.categoryId) return product.effectiveCategoryIds.has(rule.categoryId);
  return false; // XOR CHECK in the DB makes this unreachable; never match on a malformed row.
}

/** The active, channel-binding rules that touch a product. */
export function matchingRules(
  rules: readonly RestrictionRuleFacts[],
  product: ProductFacts,
  channel: RestrictionChannel,
  at: Date,
): RestrictionRuleFacts[] {
  return rules.filter(
    (r) => ruleIsActive(r, at) && ruleBindsChannel(r, channel) && ruleMatchesProduct(r, product),
  );
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

/** True when a decision could need the customer's state (so the adapter must load addresses). */
export function anyRuleNeedsState(matched: readonly RestrictionRuleFacts[]): boolean {
  return matched.some((r) => r.jurisdiction === "STATE" && ruleStates(r).length > 0);
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
  const preferred: AddressKind = precedence === "SHIPPING_FIRST" ? "SHIPPING" : "BILLING";
  const defaults = addresses.filter((a) => a.isDefault);

  let group: readonly CustomerAddressFacts[];
  if (defaults.length === 0) {
    group = addresses.length === 1 ? addresses : [];
  } else if (defaults.length > 1 && defaults.some((a) => addressKind(a) === "UNKNOWN")) {
    group = [];
  } else {
    const preferredDefaults = defaults.filter((a) => addressKind(a) === preferred);
    group = preferredDefaults.length > 0 ? preferredDefaults : defaults;
  }
  if (group.length === 0) return UNRESOLVED_STATE;

  const codes = new Set<string>();
  for (const a of group) {
    const code = normalizeUsState(a.stateCode);
    if (a.stateNeedsReview || code === null) return UNRESOLVED_STATE;
    codes.add(code);
  }
  return codes.size === 1 ? { resolved: true, state: [...codes][0] } : UNRESOLVED_STATE;
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
      reasons.push({
        productId: product.id,
        productName: product.name,
        ruleId: null,
        reason: "UNKNOWN_PRODUCT",
        message: `"${product.name}" can't be checked against selling restrictions — the product or its parent could not be found.`,
      });
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
