import type { RuleChangeDirection, RuleChangeField } from "@routeflow/types";
import { normalizeUsState } from "../common/us-states";
import { isAllCustomerRule } from "./rule-lock";

/**
 * Row 509 PR3 — which way each changed setting moves a rule, as a PURE function. "Tightens" = more products /
 * customers / time are restricted; "loosens" = fewer. The commit dialog uses it to say what the edit does; the
 * impact count (`rule-edit-impact.ts`) only runs when something tightens. Whether a rule is all-customer is decided
 * ONLY by `isAllCustomerRule` (rule-lock.ts), never by comparing the jurisdiction here.
 */

/** The settings an edit changes (the rule's current values, or the proposed ones). */
export interface RuleEditSettings {
  jurisdiction: "FEDERAL" | "STATE";
  states: readonly string[];
  surface: "ALL" | "BUYER_PORTAL";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
}

export interface RuleEditChange {
  field: RuleChangeField;
  direction: RuleChangeDirection;
}

export interface RuleEditDirectionOptions {
  /**
   * The tenant switch `selling_restrictions.enabled` is ON, so STAFF sales are judged by rules too. With it OFF only
   * the buyer portal enforces, and a rule's surface (portal-only vs everywhere) changes nothing in practice: NEUTRAL.
   */
  staffEnforced: boolean;
}

const codes = (states: readonly string[]): Set<string> =>
  new Set(states.map((s) => normalizeUsState(s) ?? s.trim().toUpperCase()).filter((s) => s !== ""));

/** `to` has MORE of the window than `from` on a side: tightens; less: loosens; both can happen (strongest wins). */
function windowDirection(
  prev: RuleEditSettings,
  next: RuleEditSettings,
): RuleChangeDirection | null {
  const time = (d: Date | null) => (d === null ? Infinity : d.getTime());
  const startDiff = next.effectiveFrom.getTime() - prev.effectiveFrom.getTime(); // < 0: starts earlier
  const endDiff = time(next.effectiveTo) - time(prev.effectiveTo); // > 0: ends later or never
  if (startDiff === 0 && (endDiff === 0 || Number.isNaN(endDiff))) return null;
  if (startDiff < 0 || endDiff > 0) return "TIGHTENS";
  return "LOOSENS";
}

/** One entry per CHANGED field, in the contract's field order; an unchanged rule yields []. */
export function ruleEditChanges(
  prev: RuleEditSettings,
  next: RuleEditSettings,
  opts: RuleEditDirectionOptions,
): RuleEditChange[] {
  const out: RuleEditChange[] = [];

  // States only mean something while BOTH sides are state rules; across an all-customer switch the jurisdiction
  // entry says it all (clearing the states to go all-customer is a tightening, not a removal).
  const prevAll = isAllCustomerRule(prev);
  const nextAll = isAllCustomerRule(next);
  if (!prevAll && !nextAll) {
    const a = codes(prev.states);
    const b = codes(next.states);
    const added = [...b].some((s) => !a.has(s));
    const removed = [...a].some((s) => !b.has(s));
    if (added) out.push({ field: "states", direction: "TIGHTENS" });
    else if (removed) out.push({ field: "states", direction: "LOOSENS" });
  }

  if (prevAll !== nextAll) {
    out.push({ field: "jurisdiction", direction: nextAll ? "TIGHTENS" : "LOOSENS" });
  }

  if (prev.surface !== next.surface) {
    const wider = next.surface === "ALL";
    out.push({
      field: "surface",
      direction: !opts.staffEnforced ? "NEUTRAL" : wider ? "TIGHTENS" : "LOOSENS",
    });
  }

  const window = windowDirection(prev, next);
  if (window) out.push({ field: "window", direction: window });

  if (prev.reason.trim() !== next.reason.trim())
    out.push({ field: "reason", direction: "NEUTRAL" });
  return out;
}
