import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZIP3_RANGES, zip3Prefix, zip3States } from "./us-zip3";
import { resolveAddressState, type AddressStateVerdict } from "./us-address-state";

/**
 * F5 — the address-level resolution (a state text plus the row's zip) is a PORT of the owner-run
 * backfill's local classification with its zip rules: ZIP3 cross-check and "an ambiguous text needs a
 * confirming civilian zip" (lead ruling, #988). This runs the script's own `classifyBatch` (Google off)
 * over a generated (state, zip) corpus in a node child and requires the SAME code, or the same reason,
 * from the port; it also compares the ZIP3 table across all 1000 prefixes and several zip formats.
 * The script stays byte-unchanged; any drift in either side fails HERE.
 */

const SCRIPT_HREF = pathToFileURL(
  path.resolve(__dirname, "../../scripts/lib/address-state-normalize.mjs"),
).href;
const ZIP3_HREF = pathToFileURL(path.resolve(__dirname, "../../scripts/lib/us-zip3.mjs")).href;

// prettier-ignore
const STATES = [
  "Texas", "TX", "tx", "Washington", "Wash.", "L.A.", "La.", "LA", "Louisiana", "California", "Calif.",
  "Oregon", "Virginia", "West Virginia", "Kansas", "Kansas City", "Indiana", "Delaware", "Nevada", "Wyoming",
  "Florida", "Georgia", "New York", "N.Y.", "Washington 20001", "Washington 98101", "Wash. 98101",
  "Virginia 22201", "TX 77001", "Texas, USA", "Tejas", "", "  ", "Unknown", "AP", "Washington DC", "DC",
  "District of Columbia", "Puerto Rico", "Guam", "Hawaii", "Georgia 30301", "Georgia 05401",
];

// prettier-ignore
const ZIPS: Array<string | null> = [
  "", null, "98101", "20001", "20500", "22201", "09001", "34001", "96201", "96799", "00100", "9810",
  "98101-1234", " 77001 ", "abcde", "70112", "90210", "77001", "10001", "66101", "30301", "05401",
];

const PAIRS = STATES.flatMap((state) => ZIPS.map((zip) => ({ state, zip })));
const ZIP_FORMS = (p: string) => [p, `${p}45`, `${p}99-1234`, ` ${p}12 `];
const PREFIXES = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, "0"));
const BAD_ZIPS = ["9810", "abc", "98x01", "", "12 345", "123456", "1234-56"];

const SHIM = `
import * as m from "${SCRIPT_HREF}";
import * as z from "${ZIP3_HREF}";
const { pairs, zips } = JSON.parse(process.env.ADDR_INPUT);
const rows = pairs.map((p, i) => ({ id: String(i), tenantId: "t", tenantSlug: "t", state: p.state, zip: p.zip,
  stateNeedsReview: false, googleSendable: false }));
const { reports } = await m.classifyBatch(rows, { google: null });
console.log(JSON.stringify({
  reports: reports.map((r) => ({ verdict: r.verdict, code: r.stateCode, reason: r.reason })),
  ranges: z.ZIP3_RANGES,
  zip3: zips.map((v) => z.zip3States(v)),
  prefixes: zips.map((v) => z.zip3Prefix(v)),
}));
`;

type ScriptOut = {
  reports: Array<{ verdict: string; code: string | null; reason: string | null }>;
  ranges: Array<[string, string, string[]]>;
  zip3: Array<string[] | null>;
  prefixes: Array<string | null>;
};

const ZIPS_FOR_TABLE = [...PREFIXES.flatMap(ZIP_FORMS), ...BAD_ZIPS];

function runScript(): ScriptOut {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
    env: { ...process.env, ADDR_INPUT: JSON.stringify({ pairs: PAIRS, zips: ZIPS_FOR_TABLE }) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`script shim failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as ScriptOut;
}

/** The script's report as the port's verdict: every "needs Google / needs zip / unparseable" is UNPARSEABLE. */
const asVerdict = (r: ScriptOut["reports"][number]): AddressStateVerdict => {
  if (r.verdict.startsWith("RESOLVED")) return { code: r.code as string, reason: null };
  const reason = r.reason ?? "";
  return {
    code: null,
    reason: ["EMPTY", "ZIP_CONFLICT", "AMBIGUOUS_NEEDS_ZIP"].includes(reason)
      ? (reason as "EMPTY" | "ZIP_CONFLICT" | "AMBIGUOUS_NEEDS_ZIP")
      : "UNPARSEABLE",
  };
};

describe("resolveAddressState is the backfill's local classification with its zip rules, ported (F5)", () => {
  const script = runScript();

  it("the corpus is large and reaches every outcome (a shrunken corpus must not report green)", () => {
    expect(PAIRS.length).toBeGreaterThan(900);
    const reasons = new Set(script.reports.map((r) => asVerdict(r).reason));
    for (const reason of [null, "EMPTY", "UNPARSEABLE", "ZIP_CONFLICT", "AMBIGUOUS_NEEDS_ZIP"])
      expect(reasons.has(reason as never)).toBe(true);
  });

  it("returns the script's code, or the same reason, for EVERY (state, zip) pair", () => {
    const mismatches = PAIRS.flatMap((pair, i) => {
      const mine = resolveAddressState(pair.state, pair.zip);
      const theirs = asVerdict(script.reports[i]);
      return JSON.stringify(mine) === JSON.stringify(theirs)
        ? []
        : [{ pair, script: theirs, mine }];
    });
    expect(mismatches).toEqual([]);
  });

  it("the ZIP3 table is the script's: the same ranges, and the same answer for all 1000 prefixes in every zip format", () => {
    expect(ZIP3_RANGES).toEqual(script.ranges);
    const bad = ZIPS_FOR_TABLE.flatMap((z, i) => {
      const ok =
        JSON.stringify(zip3States(z)) === JSON.stringify(script.zip3[i]) &&
        zip3Prefix(z) === script.prefixes[i];
      return ok ? [] : [{ zip: z, script: script.zip3[i], mine: zip3States(z) }];
    });
    expect(bad).toEqual([]);
  });

  it("names the ruled cases: an ambiguous name resolves ONLY with a confirming civilian zip; a contradicting zip is a conflict", () => {
    const code = (state: string, zip: string | null) => resolveAddressState(state, zip);
    expect(code("Washington", "98101")).toEqual({ code: "WA", reason: null });
    expect(code("Washington", "20001")).toEqual({ code: null, reason: "ZIP_CONFLICT" });
    for (const zip of [null, "", "09001", "96201", "00100", "9810"])
      expect(code("Washington", zip)).toEqual({ code: null, reason: "AMBIGUOUS_NEEDS_ZIP" });
    expect(code("Washington 98101", null)).toEqual({ code: "WA", reason: null });
    expect(code("Texas", null)).toEqual({ code: "TX", reason: null }); // unambiguous: no zip needed
    expect(code("Texas", "10001")).toEqual({ code: null, reason: "ZIP_CONFLICT" });
    expect(code("Tejas", "77001")).toEqual({ code: null, reason: "UNPARSEABLE" });
    expect(code("", "77001")).toEqual({ code: null, reason: "EMPTY" });
  });
});
