import { createHash } from "crypto";
import type { RestrictionChannel } from "@routeflow/types";
import {
  ruleBindsChannel,
  ruleHidesFromBuyer,
  ruleIsActive,
  type GoverningState,
  type RestrictionRuleFacts,
} from "../selling-restrictions/selling-restrictions.core";
import type { RuleEditSettings } from "./rule-edit-direction";

/**
 * Row 509 PR3 — the pure half of the edit impact: "would this customer be restricted by these settings?" asked of
 * the OLD and the NEW settings with the engine's OWN predicates (`ruleIsActive`, `ruleBindsChannel`,
 * `ruleHidesFromBuyer`, imported read-only), so the count can never drift from what the engine will decide.
 */

const factsOf = (s: RuleEditSettings): RestrictionRuleFacts => ({
  id: "edit-impact",
  categoryId: null,
  productId: null,
  jurisdiction: s.jurisdiction,
  states: [...s.states],
  surface: s.surface,
  effectiveFrom: s.effectiveFrom,
  effectiveTo: s.effectiveTo,
  liftedAt: null,
  reason: s.reason,
});

function restricts(
  s: RuleEditSettings,
  governingState: GoverningState,
  channel: RestrictionChannel,
  at: Date,
): boolean {
  const facts = factsOf(s);
  return (
    ruleIsActive(facts, at) &&
    ruleBindsChannel(facts, channel) &&
    ruleHidesFromBuyer(facts, governingState)
  );
}

export interface NewlyRestrictedOptions {
  /** The tenant switch is ON: the STAFF channel is judged too (otherwise only the buyer portal enforces). */
  staffEnforced: boolean;
  /** Now. A rule that has not started yet is judged at its start (the first moment the edit can bind). */
  at: Date;
}

/**
 * True when the NEW settings restrict a customer in `governingState` on some channel the OLD settings did not.
 * A state the edit only keeps, or removes, is never "newly" restricted.
 */
export function newlyRestricted(
  prev: RuleEditSettings,
  next: RuleEditSettings,
  governingState: GoverningState,
  opts: NewlyRestrictedOptions,
): boolean {
  const at = next.effectiveFrom.getTime() > opts.at.getTime() ? next.effectiveFrom : opts.at;
  const channels: RestrictionChannel[] = opts.staffEnforced
    ? ["BUYER_PORTAL", "STAFF"]
    : ["BUYER_PORTAL"];
  return channels.some(
    (ch) => restricts(next, governingState, ch, at) && !restricts(prev, governingState, ch, at),
  );
}

/**
 * The fingerprint of "which documents this edit affects": sha256 over the rule, its revision and the sorted ids
 * (callers prefix the kind, e.g. `o:` order, `d:` draft order, `i:` draft invoice). The commit recomputes it and
 * a different value is 409 RULE_IMPACT_CHANGED.
 */
export function impactHash(ruleId: string, revision: number, ids: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([ruleId, revision, [...ids].sort()]))
    .digest("hex");
}
