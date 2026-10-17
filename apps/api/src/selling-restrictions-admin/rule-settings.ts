import { BadRequestException } from "@nestjs/common";
import type { RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";
import { normalizeUsState } from "../common/us-states";
import { isAllCustomerRule } from "./rule-lock";

/**
 * Row 509 PR3 — the settings validation an in-place EDIT shares with create, as pure functions (no reads).
 * `normalizeRuleStates` is the SAME rule `SellingRestrictionsAdminService.normalizeStates` applies on create
 * (`rule-settings.spec.ts` pins the two identical on every shape; the admin service is left alone so create's
 * behaviour cannot move — fold create onto this when that file is next open).
 */

/**
 * STATE names must all be real states: the engine treats a rule naming anything it can't read as "blocks
 * everywhere", so a typo written here would silently over-block — refuse it at the door. An all-customer rule
 * applies everywhere, so it carries no states.
 */
export function normalizeRuleStates(
  jurisdiction: RestrictionJurisdiction,
  states?: readonly string[],
): string[] {
  const given = (states ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (isAllCustomerRule({ jurisdiction })) {
    if (given.length > 0) {
      throw new BadRequestException("A federal restriction applies everywhere; remove the states.");
    }
    return [];
  }
  if (given.length === 0) {
    throw new BadRequestException("A state restriction needs at least one state.");
  }
  const codes: string[] = [];
  for (const s of given) {
    const code = normalizeUsState(s);
    if (!code) throw new BadRequestException(`"${s}" is not a recognised US state.`);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** The request body of an edit (preview and commit), after DTO validation. */
export interface RuleSettingsInput {
  jurisdiction: RestrictionJurisdiction;
  states?: readonly string[];
  surface: RestrictionSurface;
  /** ISO 8601; omitted = the rule's current start. */
  effectiveFrom?: string;
  /** ISO 8601; `null` = open-ended; omitted = the rule's current end. */
  effectiveTo?: string | null;
  reason: string;
}

/** A validated set of settings: normalised states, a checked window. */
export interface PreparedRuleSettings {
  jurisdiction: RestrictionJurisdiction;
  states: string[];
  surface: RestrictionSurface;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
}

/** Validates an edit exactly as create does: the states rules, then the end after the start. */
export function prepareRuleSettings(
  input: RuleSettingsInput,
  current: { effectiveFrom: Date; effectiveTo: Date | null },
): PreparedRuleSettings {
  const states = normalizeRuleStates(input.jurisdiction, input.states);
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : current.effectiveFrom;
  const effectiveTo =
    input.effectiveTo === undefined
      ? current.effectiveTo
      : input.effectiveTo === null
        ? null
        : new Date(input.effectiveTo);
  if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw new BadRequestException("The end date must be after the start date.");
  }
  return {
    jurisdiction: input.jurisdiction,
    states,
    surface: input.surface,
    effectiveFrom,
    effectiveTo,
    reason: input.reason,
  };
}
