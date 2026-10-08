/**
 * Row 195 / SA-756r — `PROTECTED_TENANT_SLUGS` loading. A new trial tenant is neither paying nor
 * Stripe-linked, so the operator names it in the environment; the loader must fail CLOSED on every
 * malformed input and must never echo a slug.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("../../scripts/lib/protected-slugs.cjs");

const LOCAL = "postgresql://u:p@localhost:5432/routeflow";
const REMOTE = "postgresql://u:p@proxy.example.net:5432/railway";

describe("loadProtectedSlugs", () => {
  it("parses, trims, lower-cases and drops empties", () => {
    const s = lib.loadProtectedSlugs(
      { PROTECTED_TENANT_SLUGS: " Acme-Foods , ,acme-deli " },
      REMOTE,
    );
    expect([...s].sort()).toEqual(["acme-deli", "acme-foods"]);
  });

  it('"" is an explicit none on any target, a prod URL included', () => {
    expect(lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: "" }, REMOTE).size).toBe(0);
  });

  it.each([",", " ", " , ,"])(
    "a present value with no entries (%j) is refused, not read as none",
    (v) => {
      expect(() => lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: v }, REMOTE)).toThrow(
        /has no entries/,
      );
    },
  );

  it("unset on a target that is not provably local is refused", () => {
    expect(() => lib.loadProtectedSlugs({}, REMOTE)).toThrow(/not set and the database target/);
    expect(() => lib.loadProtectedSlugs({}, undefined)).toThrow(/not set/);
    expect(() => lib.loadProtectedSlugs({ NODE_ENV: "production" }, LOCAL)).toThrow(/not set/);
  });

  it("unset on a provably local target is an empty set", () => {
    expect(lib.loadProtectedSlugs({}, LOCAL).size).toBe(0);
  });

  it("a set value is applied even when the target looks local (a tunnel can fake it)", () => {
    const s = lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: "acme-foods" }, LOCAL);
    expect(s.has("acme-foods")).toBe(true);
  });

  it.each([
    ["a bad shape", "acme foods"],
    ["a leading hyphen", "-acme"],
    ["a single character", "a"],
    ["an over-long slug", "a".repeat(64)],
    ["an invalid entry among valid ones", "acme-foods,Bad_Slug"],
  ])("%s refuses everything", (_label, value) => {
    expect(() => lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: value }, REMOTE)).toThrow(
      /not a valid tenant slug/,
    );
  });

  it.each(["test", "qa-foods", "e2e-routeflow", "e2e-run-1", "ux-audit-7", "routeflow-demo"])(
    "refuses the test-pattern slug %s",
    (slug) => {
      expect(() =>
        lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: `acme-foods,${slug}` }, REMOTE),
      ).toThrow(/test-tenant slug/);
    },
  );

  it("refuses a duplicate, case-insensitively", () => {
    expect(() =>
      lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: "acme-foods,ACME-FOODS" }, REMOTE),
    ).toThrow(/duplicates/);
  });

  it("never puts a slug in an error message", () => {
    const messages: string[] = [];
    for (const value of ["acme foods", "qa-secret-1", "acme-foods,acme-foods"]) {
      try {
        lib.loadProtectedSlugs({ PROTECTED_TENANT_SLUGS: value }, REMOTE);
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    for (const m of messages) expect(m).not.toMatch(/acme|qa-secret/i);
  });
});
