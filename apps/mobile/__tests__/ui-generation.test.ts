/**
 * #2337: the per-role UI-generation flag. Every role ships OLD; the dev override works only in a
 * __DEV__ build, so a release can never be flipped by an env value.
 */
import {
  UI_GENERATION_DEFAULTS,
  UI_ROLES,
  parseNewUiOverride,
  resolveUiGeneration,
} from "../lib/ui-generation";

describe("useNewUi(role) flag", () => {
  it("every role defaults to OLD (new code lands dark)", () => {
    for (const role of UI_ROLES) expect(UI_GENERATION_DEFAULTS[role]).toBe("old");
    expect(UI_ROLES).toEqual(["customer", "driver", "operator"]);
  });

  it("with no override, the default stands in dev and release", () => {
    for (const isDev of [true, false]) {
      expect(resolveUiGeneration("customer", { isDev })).toBe("old");
      expect(resolveUiGeneration("driver", { isDev, override: "" })).toBe("old");
    }
  });

  it("a dev build honours EXPO_PUBLIC_NEW_UI for the listed roles only", () => {
    expect(resolveUiGeneration("customer", { isDev: true, override: "customer" })).toBe("new");
    expect(resolveUiGeneration("driver", { isDev: true, override: "customer" })).toBe("old");
    expect(
      resolveUiGeneration("operator", { isDev: true, override: " Customer , OPERATOR " }),
    ).toBe("new");
    for (const role of UI_ROLES) {
      expect(resolveUiGeneration(role, { isDev: true, override: "all" })).toBe("new");
    }
  });

  it("a RELEASE build ignores the override entirely", () => {
    for (const role of UI_ROLES) {
      expect(resolveUiGeneration(role, { isDev: false, override: "all" })).toBe("old");
      expect(resolveUiGeneration(role, { isDev: false, override: role })).toBe("old");
    }
  });

  it("a flipped default is new everywhere (the phase-flip PR's one-line change)", () => {
    const defaults = { ...UI_GENERATION_DEFAULTS, customer: "new" as const };
    expect(resolveUiGeneration("customer", { isDev: false, defaults })).toBe("new");
    expect(resolveUiGeneration("driver", { isDev: false, defaults })).toBe("old");
  });

  it("parses the override: unknown names are ignored, 'all' means every role", () => {
    expect([...parseNewUiOverride("driver,bogus")]).toEqual(["driver"]);
    expect(parseNewUiOverride("all").size).toBe(UI_ROLES.length);
    expect(parseNewUiOverride(undefined).size).toBe(0);
    expect(parseNewUiOverride(null).size).toBe(0);
  });
});
