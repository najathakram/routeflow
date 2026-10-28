/** SA-1027 C-G17: a run that left an error row (a family not copied, or an undo that failed) exits non-zero. */
import { ensureScriptEnv, exitCodeFor, formatReport } from "./catalog-copy.runner";

describe("catalog-copy exit code", () => {
  it("0 when nothing went wrong, a dry run, or a resume", () => {
    expect(exitCodeFor({ errors: [] } as never)).toBe(0);
    expect(exitCodeFor({ mode: "dry-run" } as never)).toBe(0);
    expect(exitCodeFor({ photosCopied: 3 })).toBe(0);
  });

  it("3 when the report holds any error row", () => {
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "copy", message: "m" }] } as never)).toBe(3);
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "undo", message: "m" }] } as never)).toBe(3);
  });
});

describe("catalog-copy report: the inactive products it leaves out", () => {
  const report = (inactiveLeft: string[]) =>
    ({
      mode: "dry-run",
      sourceProducts: 3,
      inactiveLeftOut: inactiveLeft.length,
      inactiveLeft,
      recipesLeftOut: [],
      skippedBySku: [],
      variantsSkipped: [],
      regulatedIds: [],
      regulated: 0,
      codesDropped: [],
      packOnly: [],
      tierUnitRows: 0,
      newUnits: [],
      differs: {},
    }) as never;

  it("lists them by SKU (or id) with the count", () => {
    const text = formatReport(report(["S-5", "id-9"])).join(" | ");
    expect(text).toMatch(/inactive left out: 2 [(]S-5, id-9[)]/);
  });

  it("caps the list at 20 and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => "X-" + i);
    expect(formatReport(report(many)).join(" | ")).toMatch(
      /inactive left out: 25 .*X-19.*[+]5 more/,
    );
  });
});

describe("catalog-copy report: tier units and the tenant units the ladder writer would create", () => {
  const report = (extra: Record<string, unknown>) =>
    ({
      mode: "dry-run",
      sourceProducts: 1,
      inactiveLeftOut: 0,
      inactiveLeft: [],
      recipesLeftOut: [],
      skippedBySku: [],
      variantsSkipped: [],
      regulatedIds: [],
      regulated: 0,
      codesDropped: [],
      packOnly: [],
      differs: {},
      tierUnitRows: 0,
      newUnits: [],
      ...extra,
    }) as never;

  it("prints the tier-unit count and each new unit name", () => {
    const text = formatReport(report({ tierUnitRows: 3, newUnits: ["Half case", "Pallet"] })).join(
      " | ",
    );
    expect(text).toMatch(/tier units [(]listed, not copied[)]: 3/);
    expect(text).toMatch(/ladder writer would create: 2 [(]Half case, Pallet[)]/);
  });

  it("prints a zero count with no list", () => {
    expect(formatReport(report({})).join(" | ")).toMatch(/ladder writer would create: 0 |/);
  });
});

describe("ensureScriptEnv: the script-only module boots under a bare database shell", () => {
  it("fills a missing JWT secret and refresh secret with a per-process random value", () => {
    const a: NodeJS.ProcessEnv = {};
    const b: NodeJS.ProcessEnv = {};
    ensureScriptEnv(a);
    ensureScriptEnv(b);
    expect(a.JWT_SECRET).toHaveLength(64);
    expect(a.JWT_REFRESH_SECRET).toHaveLength(64);
    expect(a.JWT_SECRET).not.toBe(a.JWT_REFRESH_SECRET);
    expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET);
  });

  it("never replaces a secret the environment already holds", () => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET: "keep-me", JWT_REFRESH_SECRET: "keep-me-too" };
    ensureScriptEnv(env);
    expect(env).toEqual({ JWT_SECRET: "keep-me", JWT_REFRESH_SECRET: "keep-me-too" });
  });
});
