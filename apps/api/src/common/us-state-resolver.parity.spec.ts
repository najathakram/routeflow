import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { US_STATES } from "./us-states";
import {
  AMBIGUOUS_STATE_TEXTS,
  US_STATE_ALIASES,
  foldState,
  resolveStateText,
  splitTrailingZipCountry,
} from "./us-state-resolver";

/**
 * F5 — the API-side text resolver is a PORT of the owner-run backfill's `classifyLocal`
 * (`apps/api/scripts/lib/address-state-normalize.mjs`, which stays byte-unchanged). This runs the
 * script's own functions in a node child (the same shim shape as `us-states-script-mirror.parity.spec.ts`)
 * over a generated corpus and requires identical `{ code, rule, ambiguous, embeddedZip }` (or null),
 * fold, zip/country split, alias table and ambiguity set. Any drift in either side fails HERE.
 */

const SCRIPT_HREF = pathToFileURL(
  path.resolve(__dirname, "../../scripts/lib/address-state-normalize.mjs"),
).href;

// Built from char codes, never raw characters, so no tool chain can make them invisible look-alikes.
const NBSP = String.fromCharCode(0xa0);
const FULLWIDTH_TX = String.fromCharCode(0xff34, 0xff38);

type Input = { v: string | null } | { undef: true };
const s = (v: string): Input => ({ v });

// prettier-ignore
const forms = ({ code, name }: { code: string; name: string }): string[] => [
  code, code.toLowerCase(), ` ${code} `, name, name.toUpperCase(), `${code}.`, `${code[0]}.${code[1]}.`,
  `${code} 77001`, `${code} 77001-1234`, `${name}, USA`, `${name},USA`, `${name} United States`,
  `${name} United States of America`, `${code} 77001 USA`, `${name} 98101`, `${name} ${NBSP}`,
];

// prettier-ignore
const aliasForms = ([alias, code]: readonly [string, string]): string[] => [
  alias, alias.toUpperCase(), `${alias[0].toUpperCase()}${alias.slice(1)}.`, `${alias} 12345`,
  `${alias}, USA`, `${code} ${alias}`,
];

// prettier-ignore
const JUNK = [
  "", " ", "\t\n", NBSP, FULLWIDTH_TX,
  ...("Unknown|N/A|Tejas|Texs|Texass|TXX|T|T X|12|77001|US|USA|United States|constructor|__proto__|" +
    "toString|hasOwnProperty|Houston TX 77001|Springfield IL|Washington DC|TX, OK|TX 77001 77002|" +
    "Texas, USA, USA|New  York|N. Y.|AA|AE|AP|FM|MH|PW|UM|Washington 20001|Wash. 98101|L.A.|La.|LA|" +
    "Louisiana 70112|Georgia,USA|Virginia 22201 US").split("|"),
];

const INPUTS: Input[] = [
  { v: null },
  { undef: true },
  ...JUNK.map(s),
  ...US_STATES.flatMap(forms).map(s),
  ...US_STATE_ALIASES.flatMap(aliasForms).map(s),
];

const SHIM = `
import * as m from "${SCRIPT_HREF}";
const inputs = JSON.parse(process.env.RESOLVER_INPUTS);
const raw = (i) => (i.undef ? undefined : i.v);
const text = (i) => (i.undef || i.v === null ? "" : String(i.v));
console.log(JSON.stringify({
  results: inputs.map((i) => {
    const r = m.classifyLocal(raw(i));
    return r.resolved
      ? { code: r.stateCode, rule: r.rule, ambiguous: r.ambiguous ?? false, embeddedZip: r.embeddedZip ?? null }
      : null;
  }),
  folds: inputs.map((i) => m.foldState(text(i))),
  splits: inputs.map((i) => m.splitTrailingZipCountry(m.foldState(text(i)))),
  aliases: m.STATE_ALIASES,
  ambiguous: [...m.AMBIGUOUS_STATE_TEXTS],
}));
`;

type ScriptOut = {
  results: Array<{
    code: string;
    rule: string;
    ambiguous: boolean;
    embeddedZip: string | null;
  } | null>;
  folds: string[];
  splits: Array<{ remainder: string | null; zip: string | null }>;
  aliases: Array<[string, string]>;
  ambiguous: string[];
};

function runScript(): ScriptOut {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
    env: { ...process.env, RESOLVER_INPUTS: JSON.stringify(INPUTS) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`script shim failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as ScriptOut;
}

const raw = (i: Input) => ("undef" in i ? undefined : i.v);
const text = (i: Input) => ("undef" in i || i.v === null ? "" : i.v);

describe("resolveStateText is the backfill's classifyLocal, ported (F5)", () => {
  const script = runScript();

  it("the corpus is large and reaches every rule, the ambiguity flag and an embedded zip (a shrunken corpus must not report green)", () => {
    expect(INPUTS.length).toBeGreaterThan(1200);
    for (const rule of ["exact", "folded-code", "folded-name", "alias", "stripped"])
      expect(script.results.some((r) => r?.rule === rule)).toBe(true);
    expect(script.results.some((r) => r?.ambiguous === true)).toBe(true);
    expect(script.results.some((r) => r?.embeddedZip)).toBe(true);
    expect(script.results.some((r) => r === null)).toBe(true);
  });

  it("the alias table and the ambiguity set are the script's, entry for entry", () => {
    expect(US_STATE_ALIASES).toEqual(script.aliases);
    expect([...AMBIGUOUS_STATE_TEXTS].sort()).toEqual([...script.ambiguous].sort());
    for (const [, code] of US_STATE_ALIASES)
      expect(US_STATES.some((st) => st.code === code)).toBe(true);
  });

  it("resolveStateText returns the script's { code, rule, ambiguous, embeddedZip } (or null) for EVERY input", () => {
    const mismatches = INPUTS.flatMap((input, i) => {
      const mine = resolveStateText(raw(input));
      return JSON.stringify(mine) === JSON.stringify(script.results[i])
        ? []
        : [{ input: raw(input), script: script.results[i], mine }];
    });
    expect(mismatches).toEqual([]);
  });

  it("foldState and splitTrailingZipCountry agree with the script's on every input", () => {
    const bad = INPUTS.flatMap((input, i) => {
      const t = text(input);
      const ok =
        foldState(t) === script.folds[i] &&
        JSON.stringify(splitTrailingZipCountry(script.folds[i])) ===
          JSON.stringify(script.splits[i]);
      return ok ? [] : [{ input: t, fold: script.folds[i], split: script.splits[i] }];
    });
    expect(bad).toEqual([]);
  });

  it("names the ruled cases: an ambiguous name is FLAGGED (never resolved on its own), an unambiguous one is not", () => {
    for (const t of [
      "Washington",
      "Kansas",
      "Oregon",
      "Florida",
      "Georgia",
      "L.A.",
      "La.",
      "Wash.",
    ])
      expect(resolveStateText(t)?.ambiguous).toBe(true);
    for (const t of ["Texas", "West Virginia", "TX", "LA", "Calif.", "New York"])
      expect(resolveStateText(t)?.ambiguous).toBe(false);
    expect(resolveStateText("Washington 20001")).toMatchObject({
      code: "WA",
      rule: "stripped",
      ambiguous: true,
      embeddedZip: "20001",
    });
    expect(resolveStateText("TX 77001")).toMatchObject({
      code: "TX",
      rule: "stripped",
      ambiguous: false,
      embeddedZip: "77001",
    });
  });

  it("still fails closed: a misspelling, a city, blank and the out-of-scope codes stay unresolved", () => {
    for (const v of [
      "Tejas",
      "Texs",
      "Houston TX 77001",
      "Springfield IL",
      "",
      "  ",
      "Unknown",
      "AP",
      "FM",
      "Washington DC",
    ])
      expect(resolveStateText(v)).toBeNull();
    expect(resolveStateText(null)).toBeNull();
    expect(resolveStateText(undefined)).toBeNull();
  });
});
