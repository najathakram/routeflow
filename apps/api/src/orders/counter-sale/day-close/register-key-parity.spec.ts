import * as fs from "fs";
import * as path from "path";
import { COUNTER_DEFAULT_REGISTER } from "../../../returns/counter-close-lock";
import { REGISTER_KEY_PATTERN, parseRegisterKey } from "./day-close-register";

/**
 * L-261 pattern: the shared register constants live in `packages/types/api/counter-register.ts`; the API keeps literal copies
 * (it never value-imports `@routeflow/types`). This spec reads the shared file as text and pins both copies to it.
 */
const SHARED = fs.readFileSync(
  path.resolve(__dirname, "../../../../../../packages/types/api/counter-register.ts"),
  "utf8",
);

describe("register key constants match packages/types", () => {
  it("the pattern is the same regular expression", () => {
    const m = SHARED.match(/export const REGISTER_KEY_PATTERN = \/(.+)\/;/);
    expect(m).not.toBeNull();
    expect(REGISTER_KEY_PATTERN.source).toBe(new RegExp(m![1]).source);
    expect(REGISTER_KEY_PATTERN.flags).toBe("");
  });

  it("the default register is the same string", () => {
    const m = SHARED.match(/export const COUNTER_DEFAULT_REGISTER = "([^"]+)";/);
    expect(m![1]).toBe(COUNTER_DEFAULT_REGISTER);
  });
});

describe("parseRegisterKey: the union pattern", () => {
  it("accepts every key the park and quick-key patterns accept, and the driver shape", () => {
    for (const ok of ["main", "b", "_x", "-x", "A_b-9", "driver:123", "a".repeat(64)]) {
      expect(parseRegisterKey(ok)).toBe(ok);
    }
  });
  it("refuses a leading ':', an empty or over-long key and other characters; never lower-cases", () => {
    for (const bad of [":x", "a".repeat(65), "a b", "a/b", "é"]) {
      expect(() => parseRegisterKey(bad)).toThrow();
    }
    expect(parseRegisterKey("Till-A")).toBe("Till-A");
    expect(parseRegisterKey(undefined)).toBe("main");
    expect(parseRegisterKey("")).toBe("main");
  });
});
