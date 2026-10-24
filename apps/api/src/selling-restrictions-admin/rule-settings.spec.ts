import { BadRequestException } from "@nestjs/common";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";
import { normalizeRuleStates, prepareRuleSettings } from "./rule-settings";

const current = {
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: new Date("2026-12-31T00:00:00Z"),
};

describe("normalizeRuleStates (create's states rules, extracted)", () => {
  it("is behaviour-identical to the admin service's create validation on every shape", () => {
    // the create path's own implementation, called as the service calls it
    const create = new (
      SellingRestrictionsAdminService as unknown as new (...a: unknown[]) => {
        normalizeStates(j: string, s?: string[]): string[];
      }
    )(null, null);
    const shapes: Array<[string, string[] | undefined]> = [
      ["STATE", ["tx", " Texas ", "CA"]],
      ["STATE", ["TX", "TX"]],
      ["STATE", []],
      ["STATE", undefined],
      ["STATE", ["Tex"]],
      ["STATE", ["", "  "]],
      ["FEDERAL", []],
      ["FEDERAL", undefined],
      ["FEDERAL", ["TX"]],
    ];
    for (const [j, s] of shapes) {
      let a: unknown;
      let b: unknown;
      try {
        a = create.normalizeStates(j, s);
      } catch (e) {
        a = (e as Error).message;
      }
      try {
        b = normalizeRuleStates(j as "STATE" | "FEDERAL", s);
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        b = (e as Error).message;
      }
      expect(b).toEqual(a);
    }
  });
});

describe("prepareRuleSettings", () => {
  const input = {
    jurisdiction: "STATE" as const,
    states: ["tx"],
    surface: "ALL" as const,
    reason: "r",
  };

  it("keeps the current window when the request omits it", () => {
    const s = prepareRuleSettings(input, current);
    expect(s.effectiveFrom).toEqual(current.effectiveFrom);
    expect(s.effectiveTo).toEqual(current.effectiveTo);
    expect(s.states).toEqual(["TX"]);
  });

  it("null effectiveTo means open-ended; a given date replaces it", () => {
    expect(prepareRuleSettings({ ...input, effectiveTo: null }, current).effectiveTo).toBeNull();
    expect(
      prepareRuleSettings({ ...input, effectiveTo: "2027-01-01T00:00:00Z" }, current).effectiveTo,
    ).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("refuses an end that is not after the start, exactly as create does", () => {
    expect(() =>
      prepareRuleSettings(
        { ...input, effectiveFrom: "2026-05-01T00:00:00Z", effectiveTo: "2026-05-01T00:00:00Z" },
        current,
      ),
    ).toThrow("The end date must be after the start date.");
    expect(() =>
      prepareRuleSettings({ ...input, effectiveFrom: "2027-02-01T00:00:00Z" }, current),
    ).toThrow("The end date must be after the start date.");
  });
});
