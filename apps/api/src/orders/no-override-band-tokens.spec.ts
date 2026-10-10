/**
 * #2716c / SA-592a — token-scan companion to the no-mirrors pin: the staff-override band
 * (half a cent) is owned by @routeflow/pricing (`withinStaffOverrideTolerance`). Nothing under
 * apps/api/src/orders may name `STAFF_OVERRIDE_TOLERANCE` or spell the literal `0.005`, so a raw
 * band compare split across lines cannot hide from the line-based pin.
 */
import * as fs from "fs";
import * as path from "path";

const BAND_TOKENS: Record<string, RegExp> = {
  STAFF_OVERRIDE_TOLERANCE: /\bSTAFF_OVERRIDE_TOLERANCE\b/g,
  "0.005": /(?<![\d.])0\.005(?!\d)/g,
};

/** file (relative to orders/) -> allowed count per token, with the reason. */
const ALLOW: Record<string, { token: string; count: number; reason: string }> = {
  "replace-all-line-build.ts": {
    token: "0.005",
    count: 1,
    reason: "prose in a B60 comment; the compare itself goes through withinStaffOverrideTolerance",
  },
};

function scanBandTokens(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of Object.entries(BAND_TOKENS)) {
    const n = (src.match(re) ?? []).length;
    if (n) out[name] = n;
  }
  return out;
}

const ordersDir = __dirname;
const sources = fs
  .readdirSync(ordersDir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(ordersDir, f), "utf8") }));

describe("no raw staff-override band tokens in apps/api/src/orders (SA-592a)", () => {
  it("scanner is not vacuous: flags the identifier and a literal split across lines", () => {
    expect(scanBandTokens("const t = STAFF_OVERRIDE_TOLERANCE;")).toEqual({
      STAFF_OVERRIDE_TOLERANCE: 1,
    });
    expect(scanBandTokens("Math.abs(a - b) <=\n  0.005")).toEqual({ "0.005": 1 });
    expect(scanBandTokens("x = 10.0050 + 0.0051 + 1.005")).toEqual({});
  });

  it("scans a non-empty set of order sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("only the allow-listed file/count carries a band token", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const { file, src } of sources) {
      const hits = scanBandTokens(src);
      if (Object.keys(hits).length) found[file] = hits;
    }
    const expected: Record<string, Record<string, number>> = {};
    for (const [file, a] of Object.entries(ALLOW)) expected[file] = { [a.token]: a.count };
    expect(found).toEqual(expected);
  });
});
