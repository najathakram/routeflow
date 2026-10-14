import type { StaffBreach } from "@routeflow/types";
import {
  matchingRules,
  ruleStates,
  UNKNOWN_PRODUCT_NAME,
  type EvaluateInput,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";

/**
 * Row 510: WHICH rules breach a staff sale, for the warning (and its coverage test). Pure: the same facts
 * `evaluateRestrictions` decides on, so a product is breached here IFF it appears in that function's `reasons`
 * (pinned by `staff-breaches.spec.ts`, a parity run over generated inputs). `evaluateRestrictions` cites ONE rule per
 * product; the warning must list EVERY rule that binds it, or an override of one rule would silently cover a second
 * that arrives later (the coverage test is `stamp.ruleIds ⊇ breach.ruleIds`).
 *
 * Rows 509/510 boundary: this file reads rule FACTS only. It does not load rules and does not edit the core.
 */

/** Why one rule breaches a product, in the engine's own terms. */
export type StaffBreachRuleKind =
  "FEDERAL" | "UNRECOGNISED" | "MALFORMED_STATE" | "STATE_HIT" | "STATE_UNRESOLVED";

export interface StaffBreachRule {
  id: string;
  kind: StaffBreachRuleKind;
  /** The rule's readable USPS codes (`[]` for federal / malformed / unrecognised). */
  states: string[];
  /** surface ALL = a legal ban that binds every channel. */
  legal: boolean;
  /** The admin-entered rule reason (shown only for a malformed rule, whose states cannot be named). */
  reason: string;
}

/** A breach with the detail the warning needs. Extends the shared `StaffBreach` (productId / outcome / ruleIds). */
export interface StaffBreachDetail extends StaffBreach {
  productName: string;
  rules: StaffBreachRule[];
  /** An unresolvable product: no rule matched, the engine fails closed (INDETERMINATE with `ruleIds: []`). */
  unknownProduct: boolean;
  /** The governing state the STATE hits were judged at (null when unresolved / not needed). */
  state: string | null;
}

const isLegal = (r: RestrictionRuleFacts): boolean => (r.surface as string) !== "BUYER_PORTAL";

function ruleDetail(rule: RestrictionRuleFacts, kind: StaffBreachRuleKind): StaffBreachRule {
  return {
    id: rule.id,
    kind,
    states: kind === "STATE_HIT" || kind === "STATE_UNRESOLVED" ? ruleStates(rule) : [],
    legal: isLegal(rule),
    reason: rule.reason,
  };
}

function breachOf(
  product: ProductFacts,
  input: EvaluateInput,
  allMatched: readonly RestrictionRuleFacts[],
): StaffBreachDetail | null {
  const state = input.governingState.resolved ? input.governingState.state : null;
  const base = { productId: product.id, productName: product.name, state };

  // Federal, an unrecognised jurisdiction and a malformed (state-less) STATE rule each block everywhere.
  const blocking: StaffBreachRule[] = [];
  for (const r of allMatched) {
    if (r.jurisdiction === "FEDERAL") blocking.push(ruleDetail(r, "FEDERAL"));
    else if ((r.jurisdiction as string) !== "STATE") blocking.push(ruleDetail(r, "UNRECOGNISED"));
    else if (ruleStates(r).length === 0) blocking.push(ruleDetail(r, "MALFORMED_STATE"));
  }
  const stateRules = allMatched.filter(
    (r) => r.jurisdiction === "STATE" && ruleStates(r).length > 0,
  );

  if (input.governingState.resolved) {
    const at = input.governingState.state;
    for (const r of stateRules)
      if (ruleStates(r).includes(at)) blocking.push(ruleDetail(r, "STATE_HIT"));
    if (blocking.length === 0) return null;
    return {
      ...base,
      outcome: "BLOCK",
      ruleIds: blocking.map((r) => r.id),
      rules: blocking,
      unknownProduct: false,
    };
  }

  // State unresolved. Anything that blocks everywhere still blocks (and outranks INDETERMINATE).
  if (blocking.length > 0) {
    return {
      ...base,
      outcome: "BLOCK",
      ruleIds: blocking.map((r) => r.id),
      rules: blocking,
      unknownProduct: false,
    };
  }
  // The engine allows a customer with no state where EVERY matched STATE rule is a portal-only limit (owner ruling 2).
  // `stateRules` omits malformed rules, which cannot be here (they would have blocked above).
  const allStateRules = allMatched.filter((r) => r.jurisdiction === "STATE");
  if (allStateRules.length === 0 || allStateRules.every((r) => !isLegal(r))) return null;
  const pending = allStateRules.map((r) => ruleDetail(r, "STATE_UNRESOLVED"));
  return {
    ...base,
    outcome: "INDETERMINATE",
    ruleIds: pending.map((r) => r.id),
    rules: pending,
    unknownProduct: false,
  };
}

/**
 * Every breached product of `input`, in product order. An unresolvable product is INDETERMINATE with `ruleIds: []` (no
 * rule could be matched); everything else lists ALL the rules that make it BLOCK or INDETERMINATE.
 */
export function staffBreaches(input: EvaluateInput): StaffBreachDetail[] {
  const out: StaffBreachDetail[] = [];
  for (const product of input.products) {
    if (product.unresolvable) {
      out.push({
        productId: product.id,
        productName: product.nameKnown ? product.name : UNKNOWN_PRODUCT_NAME,
        outcome: "INDETERMINATE",
        ruleIds: [],
        rules: [],
        unknownProduct: true,
        state: null,
      });
      continue;
    }
    const matched = matchingRules(input.rules, product, input.channel, input.at);
    if (matched.length === 0) continue;
    const breach = breachOf(product, input, matched);
    if (breach) out.push(breach);
  }
  return out;
}
