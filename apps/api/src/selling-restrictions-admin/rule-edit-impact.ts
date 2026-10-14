import { createHash } from "crypto";
import type { RestrictionChannel } from "@routeflow/types";
import {
  ruleBindsChannel,
  ruleHidesFromBuyer,
  ruleIsActive,
  type GoverningState,
  type RestrictionRuleFacts,
} from "../selling-restrictions/selling-restrictions.core";
import { normalizeUsState } from "../common/us-states";
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
 * The instants an edit is judged at. The first moment the NEW rule can bind (now, or its start when that is later);
 * and, when the edit EXTENDS the END (a later or removed `effectiveTo`), the OLD end instant: the rule is half-open
 * `[from, to)`, so at the old `to` the old rule has stopped and the new one has not. Without the second instant an
 * end extension would always count 0 (today both rules cover everyone they cover today).
 */
function judgedAt(prev: RuleEditSettings, next: RuleEditSettings, now: Date): Date[] {
  const first = next.effectiveFrom.getTime() > now.getTime() ? next.effectiveFrom : now;
  const times = [first];
  const oldEnd = prev.effectiveTo;
  if (
    oldEnd !== null &&
    oldEnd.getTime() > first.getTime() &&
    (next.effectiveTo === null || next.effectiveTo.getTime() > oldEnd.getTime())
  ) {
    times.push(oldEnd);
  }
  return times;
}

/**
 * True when the NEW settings restrict a customer in `governingState` on some channel, at some judged instant, that the
 * OLD settings did not. A state the edit only keeps, or removes, is never "newly" restricted.
 */
export function newlyRestricted(
  prev: RuleEditSettings,
  next: RuleEditSettings,
  governingState: GoverningState,
  opts: NewlyRestrictedOptions,
): boolean {
  const channels: RestrictionChannel[] = opts.staffEnforced
    ? ["BUYER_PORTAL", "STAFF"]
    : ["BUYER_PORTAL"];
  return judgedAt(prev, next, opts.at).some((at) =>
    channels.some(
      (ch) => restricts(next, governingState, ch, at) && !restricts(prev, governingState, ch, at),
    ),
  );
}

/** A capped scan: the hash stands for the proposed settings and the cap, since the counts are lower bounds. */
export interface CappedImpact {
  capped: true;
  cap: number;
}

/**
 * The fingerprint of an edit: sha256 over the rule, its revision, the NORMALISED proposed settings (jurisdiction,
 * sorted USPS states, surface, window, reason) and the sorted ids of the documents it affects (callers prefix the
 * kind: `o:` order, `d:` draft order, `i:` draft invoice). The commit recomputes it from ITS body, so confirming a
 * different edit than the one previewed, or a changed set of documents, is 409 RULE_IMPACT_CHANGED.
 * When the scan was CAPPED the ids are a partial, order-dependent sample, so the hash covers `{ capped, cap }` instead:
 * a new matching order cannot invalidate a preview that already said "this many or more".
 */
export function impactHash(
  ruleId: string,
  revision: number,
  ids: readonly string[],
  proposed: RuleEditSettings,
  capped?: CappedImpact,
): string {
  const states = [
    ...new Set(proposed.states.map((x) => normalizeUsState(x) ?? x.trim().toUpperCase())),
  ].sort();
  const settings = {
    jurisdiction: proposed.jurisdiction,
    states,
    surface: proposed.surface,
    effectiveFrom: proposed.effectiveFrom.toISOString(),
    effectiveTo: proposed.effectiveTo ? proposed.effectiveTo.toISOString() : null,
    reason: proposed.reason.trim(),
  };
  const scope = capped ? { capped: true, cap: capped.cap } : [...ids].sort();
  return createHash("sha256")
    .update(JSON.stringify([ruleId, revision, settings, scope]))
    .digest("hex");
}
