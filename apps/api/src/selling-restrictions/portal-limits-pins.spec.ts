import * as fs from "fs";
import * as path from "path";

/**
 * Portal limits (lane A) inventory pins: the two single sources must stay single.
 *
 *   1. `buyerVisibilityFor` is the ONLY source of a buyer's visibility context. `noBuyerRestrictions(`
 *      (the explicit "nothing hidden") exists for `isBuyerVisibleBase` and nowhere else; a new bare call
 *      site would put a product the tenant limited back on a portal surface.
 *   2. Row 510 deleted the tenant switch (`selling_restrictions.enabled`) and `restrictionsApply`: no channel is gated
 *      by it, a staff sale is always judged and the portal always applies its rules. NO reader of a policy `.enabled`
 *      flag remains anywhere in the API (`RestrictionsPolicy` has no such field); a new `getPolicy(...).enabled` /
 *      `policy.enabled` short-circuit would turn a judgement off with it, so this pin allows none.
 *
 * Source scan with comments stripped (a comment or a doc example never counts); each detector has a
 * positive control on inline source so the pin cannot go quietly blind.
 */
const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "testing") continue;
      sourceFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

const BARE_NO_RESTRICTIONS = /\bnoBuyerRestrictions\(/;
const POLICY_SHORT_CIRCUIT =
  /(?:getPolicy\([^)]*\)\)?|\bpolicy|\bbefore|\bafter)\.enabled\b|\{[^}]*\benabled\b[^}]*\}\s*=\s*(?:await\s+)?[\w.]*getPolicy\(/;
const VISIBILITY_CALL = /\b(?:buyerVisibleProductWhere|isBuyerVisibleProduct)\(/;

describe("portal limits pins: one visibility context, no switch gate", () => {
  const files = sourceFiles(SRC).map((f) => ({
    file: rel(f),
    code: stripComments(fs.readFileSync(f, "utf8")),
  }));

  it("scans the real tree (guards against a path typo making every pin vacuous)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.file === "buyer/buyer-product-visibility.ts")).toBe(true);
  });

  it("noBuyerRestrictions( is called only inside buyer-product-visibility.ts", () => {
    const offenders = files
      .filter(
        (f) => f.file !== "buyer/buyer-product-visibility.ts" && BARE_NO_RESTRICTIONS.test(f.code),
      )
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("every file that builds a buyer product predicate gets its context from buyerVisibilityFor", () => {
    const offenders = files
      .filter(
        (f) =>
          f.file !== "buyer/buyer-product-visibility.ts" &&
          VISIBILITY_CALL.test(f.code) &&
          !/\bbuyerVisibilityFor\b/.test(f.code),
      )
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("NO reader of the policy `.enabled` flag exists anywhere (row 510: the switch is gone)", () => {
    const offenders = files.filter((f) => POLICY_SHORT_CIRCUIT.test(f.code)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the switch's constants, readiness probe and write path are gone from the source", () => {
    const all = files.map((f) => f.code).join("\n");
    expect(all).not.toMatch(
      /SYSTEM_CONFIG_ENABLED|SELLING_RESTRICTIONS_ENABLED_VALUE|SELLING_RESTRICTIONS_DISABLED_VALUE|assertReadyToEnable|getEnableReadiness/,
    );
    expect(all).not.toMatch(/["']selling_restrictions\.enabled["']/);
  });

  describe("positive controls (the detectors really fire)", () => {
    it("flags a bare noBuyerRestrictions call and ignores one in a comment", () => {
      expect(BARE_NO_RESTRICTIONS.test(stripComments("const v = noBuyerRestrictions(t);"))).toBe(
        true,
      );
      expect(BARE_NO_RESTRICTIONS.test(stripComments("// noBuyerRestrictions(t) is gone\n"))).toBe(
        false,
      );
    });

    it("flags a getPolicy().enabled and a policy.enabled short-circuit", () => {
      expect(
        POLICY_SHORT_CIRCUIT.test(
          stripComments("if (!(await r.getPolicy(t)).enabled) return null;"),
        ),
      ).toBe(true);
      expect(POLICY_SHORT_CIRCUIT.test(stripComments("if (!policy.enabled) return;"))).toBe(true);
      expect(
        POLICY_SHORT_CIRCUIT.test(
          stripComments("const { enabled } = await this.restrictions.getPolicy(t);"),
        ),
      ).toBe(true);
      expect(POLICY_SHORT_CIRCUIT.test(stripComments("evaluate(policy, channel)"))).toBe(false);
    });
  });
});
