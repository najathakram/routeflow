import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { US_STATES, normalizeUsState } from "@routeflow/types";

/**
 * Keep-in-lock-step guard for `apps/api/scripts/lib/us-states.mjs` — the plain-JS mirror of
 * `packages/types/api/us-states.ts` that the standalone `normalize-address-states.mjs` script
 * consults because it runs under bare `node` (via `railway run`) and cannot import TypeScript.
 * Same convention as `feature-registry-mirror.parity.spec.ts`: the REAL module is imported here (it
 * is available to a Jest spec, unlike to the script) and every value the mirror copies is
 * compared, so a change to the shared table or to `normalizeUsState` that is not ported to the
 * mirror fails THIS spec rather than a code comment's promise.
 *
 * The mirror is ESM and this suite runs under ts-jest's CommonJS transform, so it is evaluated in
 * ONE `node --input-type=module` child that imports it by `file://` URL and prints JSON — the same
 * shim shape as `backfill-legacy-tenant-ids-script.spec.ts`. No database, no network.
 */

const MIRROR_HREF = pathToFileURL(path.resolve(__dirname, "../../scripts/lib/us-states.mjs")).href;

// Built from a char code, never written as an escape sequence, so no tool chain can turn it into
// an invisible raw character in this file.
const NBSP = String.fromCharCode(0xa0);

type Input = { v: string | null } | { undef: true };

const SHIM = `
import * as mirror from "${MIRROR_HREF}";
const inputs = JSON.parse(process.env.US_STATES_INPUTS);
const results = inputs.map((i) => mirror.normalizeUsState(i.undef ? undefined : i.v));
console.log(JSON.stringify({
  exports: Object.keys(mirror).sort(),
  states: mirror.US_STATES,
  results,
}));
`;

const s = (v: string): Input => ({ v });

const junk = [
  "",
  " ",
  "\t\n",
  "Unknown",
  "N/A",
  "Tejas",
  "Texs",
  "Texass",
  "TXX",
  "T",
  "T X",
  "12",
  "XX",
  "US",
  "UK",
  "United States",
  "New  York", // double space: NOT the table's name
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  NBSP, // NBSP-only
];

const INPUTS: Input[] = [
  { v: null },
  { undef: true },
  ...junk.map(s),
  ...US_STATES.flatMap(({ code, name }) => [
    s(code),
    s(code.toLowerCase()),
    s(code[0] + code[1].toLowerCase()),
    s(`  ${code}  `),
    s(`\t${code}\n`),
    s(`${NBSP}${code}${NBSP}`),
    s(name),
    s(name.toUpperCase()),
    s(name.toLowerCase()),
    s(`  ${name}\t`),
    s(`${code}.`),
    s(`${name}.`),
    s(`${code}x`),
    s(`${name} 77001`),
  ]),
];

const child = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
  encoding: "utf8",
  env: { ...process.env, US_STATES_INPUTS: JSON.stringify(INPUTS) },
  timeout: 60_000,
});

function loadMirror() {
  if (child.status !== 0) {
    throw new Error(`us-states mirror shim exited ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout.trim()) as {
    exports: string[];
    states: { code: string; name: string }[];
    results: (string | null)[];
  };
}

describe("us-states.mjs mirrors packages/types/api/us-states.ts", () => {
  it("P1: exports exactly US_STATES and normalizeUsState", () => {
    expect(loadMirror().exports).toEqual(["US_STATES", "normalizeUsState"]);
  });

  it("P2: the state table is deep-equal, in the same order", () => {
    expect(loadMirror().states).toEqual(US_STATES);
    // a sanity floor so an emptied table can never be "equal" to another emptied table
    expect(US_STATES.length).toBeGreaterThanOrEqual(56);
    expect(new Set(US_STATES.map((st) => st.code)).size).toBe(US_STATES.length);
  });

  it("P3: normalizeUsState agrees on every code, name, case, padding and a set of junk inputs", () => {
    const { results } = loadMirror();
    expect(results).toHaveLength(INPUTS.length);
    const mismatches: string[] = [];
    INPUTS.forEach((input, i) => {
      const value = "undef" in input ? undefined : input.v;
      const expected = normalizeUsState(value);
      if (results[i] !== expected) {
        mismatches.push(`${JSON.stringify(value)}: mirror=${results[i]} shared=${expected}`);
      }
    });
    expect(mismatches).toEqual([]);
  });

  it("P4: the inputs actually exercise both outcomes (the comparison is not vacuous)", () => {
    const { results } = loadMirror();
    const resolved = results.filter((r) => r !== null).length;
    // every state: code x6 spellings + name x3 spellings + padded name = at least 10 hits each
    expect(resolved).toBeGreaterThanOrEqual(US_STATES.length * 10);
    expect(results.filter((r) => r === null).length).toBeGreaterThan(junk.length);
  });
});
