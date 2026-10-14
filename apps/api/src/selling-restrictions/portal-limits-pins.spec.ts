import * as fs from "fs";
import * as path from "path";

/**
 * Portal limits (lane A) inventory pins: the two single sources must stay single.
 *
 *   1. `buyerVisibilityFor` is the ONLY source of a buyer's visibility context. `noBuyerRestrictions(`
 *      (the explicit "nothing hidden") exists for `isBuyerVisibleBase` and nowhere else; a new bare call
 *      site would put a product the tenant limited back on a portal surface.
 *   2. Row 510 deleted `restrictionsApply`: the tenant switch (`selling_restrictions.enabled`) gates NO channel in the
 *      engine, so a staff sale is always judged and the portal always applies its rules. What is left is the readers
 *      of the stored flag outside the engine (the settings screen and two staff reports), listed below with why;
 *      brief 3 of row 510 removes them and tightens this pin to none. A new `getPolicy(...).enabled` /
 *      `policy.enabled` short-circuit anywhere else would turn a judgement off with it.
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

/** Files that may read the policy's `enabled` flag, and why none of them is an engine short-circuit (row 510: the engine has none). */
const ENABLED_READERS: Record<string, string> = {
  "restrictions-settings/restrictions-settings.service.ts":
    "the settings screen reads and writes the switch",
  "regulated/regulated-report.service.ts":
    "staff regulated report: skips a timezone read when the engine is off",
  "regulated/uncategorised-lines.ts":
    "staff review warning for custom lines; no portal channel exists here",
};

describe("portal limits pins: one visibility context, one switch gate", () => {
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

  it("no reader of the policy `.enabled` flag exists outside restrictions-settings and the two staff reports", () => {
    const offenders = files
      .filter((f) => !(f.file in ENABLED_READERS) && POLICY_SHORT_CIRCUIT.test(f.code))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the listed readers still exist (a stale allowlist entry is dead weight)", () => {
    for (const f of Object.keys(ENABLED_READERS)) {
      expect(files.some((x) => x.file === f)).toBe(true);
    }
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
