import { buildFallbackSourceKey, signClassOf } from "./sign-class";

// SA-1295 A1 C6 Rule 3: the fallback key carries the sign class, never an inferred kind.
describe("sign-class fallback key", () => {
  it("classes a non-negative net as untyped+ and a negative net as untyped-", () => {
    expect(signClassOf(10)).toBe("untyped+");
    expect(signClassOf(0)).toBe("untyped+");
    expect(signClassOf(null)).toBe("untyped+");
    expect(signClassOf(-0.01)).toBe("untyped-");
  });

  it("builds a key that carries the sign class and the source number", () => {
    expect(buildFallbackSourceKey("untyped+", "1001")).toBe("untyped+:1001");
    expect(buildFallbackSourceKey("untyped-", "1001")).toBe("untyped-:1001");
  });

  it("the same number in both sign classes gives two different keys", () => {
    expect(buildFallbackSourceKey("untyped+", "1001")).not.toBe(
      buildFallbackSourceKey("untyped-", "1001"),
    );
  });

  it("never carries an inferred kind in the key", () => {
    for (const sc of ["untyped+", "untyped-"] as const) {
      expect(buildFallbackSourceKey(sc, "77")).not.toMatch(/credit|memo|invoice|negative/i);
    }
  });

  it("keeps the number verbatim apart from trimming", () => {
    expect(buildFallbackSourceKey("untyped+", " 00123 ")).toBe("untyped+:00123");
  });
});
