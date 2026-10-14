import { RULE_TARGETS_MAX_PER_REQUEST, RULE_TARGETS_MAX_PER_RULE } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { RULE_ERROR_COPY, ownsRuleCodes, ruleErrorCode } from "./restriction-rule-errors";

const err = (status: number, data: object) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

describe("rule error codes", () => {
  it("reads body.code, never the message", () => {
    expect(ruleErrorCode(err(409, { code: "RULE_STALE", message: "raw" }))).toBe("RULE_STALE");
    expect(ruleErrorCode(err(409, { message: "raw" }))).toBeNull();
    expect(ruleErrorCode(new Error("x"))).toBeNull();
    expect(ruleErrorCode(null)).toBeNull();
  });

  it("a mutation owns only the codes it lists; the rest reach the global toast", () => {
    const owns = ownsRuleCodes("RULE_STALE", "RULE_IMPACT_CHANGED");
    expect(owns(err(409, { code: "RULE_STALE" }))).toBe(true);
    expect(owns(err(409, { code: "RULE_NOT_EDITABLE" }))).toBe(false);
    expect(owns(err(400, {}))).toBe(false);
  });

  it("every RULE_* code has fixed plain copy, and the global toast uses it (never the server sentence)", () => {
    for (const code of Object.keys(RULE_ERROR_COPY)) {
      expect(genericToastCopy(err(409, { code, message: "raw server sentence" }))).toBe(
        RULE_ERROR_COPY[code],
      );
    }
    expect(Object.keys(RULE_ERROR_COPY).sort()).toEqual([
      "RULE_END_USE_LIFT",
      "RULE_IMPACT_CHANGED",
      "RULE_IMPACT_TOO_LARGE",
      "RULE_NEEDS_A_TARGET",
      "RULE_NOT_EDITABLE",
      "RULE_STALE",
      "RULE_TARGETS_NOT_FOUND",
      "RULE_TARGET_LIMIT",
    ]);
  });

  it("the limit copy names the caps from the contract constants", () => {
    expect(RULE_ERROR_COPY.RULE_TARGET_LIMIT).toContain(
      RULE_TARGETS_MAX_PER_REQUEST.toLocaleString("en-US"),
    );
    expect(RULE_ERROR_COPY.RULE_TARGET_LIMIT).toContain(
      RULE_TARGETS_MAX_PER_RULE.toLocaleString("en-US"),
    );
  });
});
