import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Row 509 — the coded errors of rule-target and rule-edit writes, built in ONE place (the contract in
 * packages/types/api/restrictions-admin.ts documents each). Fixed, plain copy; the web branches on `code`.
 * RULE_NOT_EDITABLE lives with the lock (rule-lock.ts).
 */

/** 409: an id is not this tenant's product / label; nothing was written. */
export function ruleTargetsNotFound(notFoundIds: string[]): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RULE_TARGETS_NOT_FOUND,
    message:
      notFoundIds.length === 1
        ? "One of these products or labels no longer exists. Nothing was changed. Reload and try again."
        : `${notFoundIds.length} of these products or labels no longer exist. Nothing was changed. Reload and try again.`,
    notFoundIds,
  });
}

/** 409: the call would leave the rule covering nothing. */
export function ruleNeedsATarget(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RULE_NEEDS_A_TARGET,
    message: "A rule has to cover at least one product or label. Lift the rule instead.",
  });
}

/** 400: too many ids in one call, or the rule would hold more than its cap. */
export function ruleTargetLimit(field: "request" | "rule", max: number): BadRequestException {
  return new BadRequestException({
    code: API_ERROR_CODES.RULE_TARGET_LIMIT,
    message:
      field === "request"
        ? `Add or remove up to ${max.toLocaleString("en-US")} at a time.`
        : `A rule can cover up to ${max.toLocaleString("en-US")} products and labels. Split it into two rules.`,
    field,
    max,
  });
}

/** 409: someone saved this rule since it was opened (PR3 edit). */
export function ruleStale(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RULE_STALE,
    message:
      "Someone changed this rule since you opened it. Reload to see the latest, then make your change again.",
  });
}

/** 409: the open orders this edit affects changed since the preview (PR3 edit). */
export function ruleImpactChanged(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RULE_IMPACT_CHANGED,
    message:
      "The orders this change affects have changed since you checked. Review the change again.",
  });
}

/** 400: an edit set the end to now or earlier. Ending a rule is a lift (it needs a reason and ends the rule at once). */
export function ruleEndUseLift(): BadRequestException {
  return new BadRequestException({
    code: API_ERROR_CODES.RULE_END_USE_LIFT,
    message: "To end this rule now, lift it.",
  });
}

/** 409: the edit reaches more open orders and drafts than the preview counts (the scan is bounded). */
export function ruleImpactTooLarge(max: number): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RULE_IMPACT_TOO_LARGE,
    message: `This change reaches more than ${max.toLocaleString("en-US")} open orders and drafts, too many to check here. Narrow the change, or add a new rule instead.`,
    max,
  });
}
