import { RULE_TARGETS_MAX_PER_REQUEST, RULE_TARGETS_MAX_PER_RULE } from "@routeflow/types";

/**
 * Row 509: the coded refusals of rule-target and rule-edit writes (documented in
 * packages/types/api/restrictions-admin.ts). The UI branches on `body.code` and says FIXED plain copy,
 * never the server sentence. A mutation that renders one of these itself (the last-product guard, the
 * stale / impact banners) tells the app-wide mutation toast to skip exactly those codes with
 * `ownsRuleCodes`; every other RULE_* refusal reaches the global toast, which reads this same copy
 * (generic-toast-copy.ts), so one failure is one message.
 */
export const RULE_ERROR_COPY: Record<string, string> = {
  RULE_NOT_EDITABLE: "This rule has ended or been lifted, so it can't be changed.",
  RULE_TARGETS_NOT_FOUND:
    "One or more of these products or labels no longer exists. Nothing was changed. Reload and try again.",
  RULE_NEEDS_A_TARGET: "A rule has to cover at least one product or label. Lift the rule instead.",
  RULE_TARGET_LIMIT: `Too many at once. Change up to ${RULE_TARGETS_MAX_PER_REQUEST.toLocaleString("en-US")} at a time; a rule can cover up to ${RULE_TARGETS_MAX_PER_RULE.toLocaleString("en-US")}.`,
  RULE_STALE:
    "Someone changed this rule since you opened it. Reload to see the latest, then make your change again.",
  RULE_IMPACT_CHANGED: "The open orders this change affects have changed. Review the change again.",
  RULE_END_USE_LIFT: "To end this rule now, lift it.",
};

/** The server's `body.code` of a refused request, or null. */
export function ruleErrorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === "string" ? code : null;
}

/** `meta.localErrorToast` predicate: the surface renders exactly these codes itself. */
export const ownsRuleCodes =
  (...codes: string[]) =>
  (error: unknown): boolean => {
    const code = ruleErrorCode(error);
    return code !== null && codes.includes(code);
  };
