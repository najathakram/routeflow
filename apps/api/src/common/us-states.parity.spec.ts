import { US_STATES as SHARED_STATES, normalizeUsState as sharedNormalize } from "@routeflow/types";
import { US_STATES, normalizeUsState } from "./us-states";

/**
 * The API mirror of `packages/types/api/us-states.ts` must stay identical to the shared source
 * (the API cannot value-import `@routeflow/types` — see `no-runtime-workspace-imports.spec.ts`).
 */
describe("us-states API mirror parity", () => {
  it("has the same state/territory table, in the same order", () => {
    expect(US_STATES.length).toBeGreaterThan(50);
    expect(US_STATES).toEqual(SHARED_STATES);
  });

  it("normalizes every code and every full name (any case, padded) exactly like the shared source", () => {
    const inputs: Array<string | null | undefined> = [];
    for (const { code, name } of SHARED_STATES) {
      inputs.push(
        code,
        code.toLowerCase(),
        ` ${code} `,
        name,
        name.toUpperCase(),
        name.toLowerCase(),
      );
    }
    inputs.push(
      null,
      undefined,
      "",
      "  ",
      "Unknown",
      "Tejas",
      "ZZ",
      "XX",
      "Washington DC",
      "N.Y.",
      "TX, OK",
      "Tex",
    );
    for (const input of inputs) {
      expect(normalizeUsState(input)).toBe(sharedNormalize(input));
    }
  });

  it("round-trips: every code and every name resolves to its own code", () => {
    for (const { code, name } of SHARED_STATES) {
      expect(normalizeUsState(code)).toBe(code);
      expect(normalizeUsState(name)).toBe(code);
    }
  });

  it.each(["AA", "AE", "AP", "FM", "MH", "PW", "UM"])(
    "military / freely-associated code %s is OUT OF SCOPE by design: it normalizes to null (fail closed, listed for review) in both copies",
    (code) => {
      for (const input of [code, code.toLowerCase(), ` ${code} `]) {
        expect(normalizeUsState(input)).toBeNull();
        expect(sharedNormalize(input)).toBeNull();
      }
      expect(US_STATES.some((s) => s.code === code)).toBe(false);
      expect(SHARED_STATES.some((s) => s.code === code)).toBe(false);
    },
  );
});
