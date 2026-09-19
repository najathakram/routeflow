import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { US_STATES } from "@routeflow/types";

/**
 * Contract for the owner-run address-state backfill:
 * `apps/api/scripts/normalize-address-states.mjs` and its pure decision layer
 * `apps/api/scripts/lib/address-state-normalize.mjs` (which mirrors `normalizeUsState` through
 * `lib/us-states.mjs`; the mirror itself is pinned by `us-states-script-mirror.parity.spec.ts`).
 *
 * No database and no network are touched. Two techniques, both already house style here (see
 * `backfill-legacy-tenant-ids-script.spec.ts`):
 *   - the pure module is ESM (`.mjs`) and this suite runs under ts-jest's CommonJS transform, so
 *     every case is evaluated in ONE `node --input-type=module` child that imports the real module
 *     by `file://` URL, receives the cases on stdin and prints a JSON array. The Google leg runs
 *     there too, against a FAKE `fetchImpl` built from a per-case script — nothing ever leaves
 *     the machine.
 *   - the CLI's argument refusals are exercised by spawning it, with no database URL that could
 *     connect.
 *
 * What must never regress: an unresolvable state is LISTED and never guessed (no fuzzy matching:
 * "Tejas" / "Texs" stay unresolved); Google is opt-in, capped, and accepts only a COMPLETE US
 * answer whose administrativeArea is a state; the request carries only region + two address lines;
 * neither the key nor an address line, city, zip, coordinate or name ever reaches an output;
 * the write list is id-pinned, parameterized and guarded on `"stateCode" IS NULL`, and an
 * unresolved row is only ever FLAGGED; NULL-tenant rows are never written; `--only-test-tenants`
 * refuses the whole batch on one offender; and every refusal that can happen before a connection
 * does.
 */

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/normalize-address-states.mjs");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/address-state-normalize.mjs"),
).href;

// Built from char codes, never written as escape sequences, so no tool chain can turn them into
// invisible raw characters in this file.
const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const LSEP = String.fromCharCode(0x2028);
const BEL = String.fromCharCode(7);
const FULLWIDTH_TX = String.fromCharCode(0xff34, 0xff38);
const U_ESC = (codePoint: number) => "\\" + "u" + codePoint.toString(16).padStart(4, "0");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

// A key that can never be real and that no output may ever contain.
const KEY = "AIzaSy-SPEC-FAKE-KEY-never-real";

// Fixture address data: deliberately fake, deliberately distinctive, so a leak is a plain
// substring match. NONE of these may appear in any prose line, JSON document or error.
const FIXTURE = {
  line1: "9999 Fixture Lane",
  line2: "Suite 999 Fixture",
  city: "Faketown",
  zip: "99999",
  businessName: "Fixture Business LLC",
  email: "fixture@example.invalid",
  lat: 12.3456,
  lng: 65.4321,
};

// ─── one child process evaluates every pure-module case ───────────────────────────────────────

const SHIM = `
import fs from "node:fs";
import * as lib from "${LIB_HREF}";
const cases = JSON.parse(fs.readFileSync(0, "utf8"));

function makeFetch(script, calls) {
  let n = 0;
  return async (url, init) => {
    calls.push({
      url: String(url),
      method: init && init.method,
      headers: init && init.headers,
      body: init && init.body,
    });
    const step = script[Math.min(n++, script.length - 1)];
    if (step.throwName) {
      const e = new Error(step.message || "boom");
      e.name = step.throwName;
      throw e;
    }
    if (step.hang) return new Promise(() => {});
    if (step.badJson) {
      return { status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } };
    }
    return { status: step.status, json: async () => step.body };
  };
}

async function run(c) {
  const calls = [];
  try {
    if (c.kind === "call") return { ok: true, value: lib[c.fn](...(c.args || [])), calls };
    if (c.kind === "get") {
      const v = lib[c.name];
      return { ok: true, value: v instanceof Set ? [...v] : v, calls };
    }
    if (c.kind === "batch" || c.kind === "pipeline") {
      const google = c.google
        ? {
            apiKey: c.google.apiKey,
            max: c.google.max,
            timeoutMs: c.google.timeoutMs,
            fetchImpl: makeFetch(c.google.script, calls),
          }
        : null;
      const batch = await lib.classifyBatch(c.rows, { google });
      if (c.kind === "batch") return { ok: true, value: batch, calls };
      const updates = lib.buildUpdates(batch.reports);
      return {
        ok: true,
        calls,
        value: {
          lines: batch.reports.map((r) => lib.reportLine(r)),
          json: JSON.stringify({ rows: batch.reports, updates, google: batch.google }),
          summary: lib.summarize(batch.reports, updates),
          updates,
        },
      };
    }
    throw new Error("unknown case kind: " + c.kind);
  } catch (e) {
    return { ok: false, name: e.name, message: e.message, calls };
  }
}

const out = [];
for (const c of cases) out.push(await run(c));
console.log(JSON.stringify(out));
`;

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };
type Outcome = {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
  name?: string;
  message?: string;
  calls: Call[];
};

function evaluate(cases: unknown[]): Outcome[] {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
    encoding: "utf8",
    input: JSON.stringify(cases),
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`address-state-normalize shim exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim()) as Outcome[];
}

const call = (fn: string, ...args: unknown[]) => ({ kind: "call", fn, args });
const get = (name: string) => ({ kind: "get", name });

// ─── L: local classification (exhaustive, table-driven) ───────────────────────────────────────

const EXACT = "RESOLVED_LOCAL_EXACT";
const ALIAS = "RESOLVED_LOCAL_ALIAS";

type LocalCase = {
  input: string | null | undefined;
  code?: string;
  verdict?: string;
  reason?: string;
};
const LOCAL: LocalCase[] = [];
const resolves = (input: string, code: string, verdict: string) =>
  LOCAL.push({ input, code, verdict });
const unresolved = (input: string | null | undefined, reason: string) =>
  LOCAL.push({ input, reason });

// Rule 1 — every state and territory, by code and by name, in every case and padding.
for (const { code, name } of US_STATES) {
  const mixed = code[0] + code[1].toLowerCase();
  for (const spelling of [
    code,
    code.toLowerCase(),
    mixed,
    `  ${code}  `,
    `\t${code}\n`,
    `${NBSP}${code}${NBSP}`,
    name,
    name.toUpperCase(),
    name.toLowerCase(),
    `  ${name}\t`,
    `${name.toUpperCase()}   `,
  ]) {
    resolves(spelling, code, EXACT);
  }
}

// Rule 2 — the traditional GPO/AP abbreviations, restated INDEPENDENTLY of the module under test.
const GPO: Array<[string, string]> = [
  ["Ala", "AL"],
  ["Ariz", "AZ"],
  ["Ark", "AR"],
  ["Calif", "CA"],
  ["Colo", "CO"],
  ["Conn", "CT"],
  ["Del", "DE"],
  ["Fla", "FL"],
  ["Ga", "GA"],
  ["Ill", "IL"],
  ["Ind", "IN"],
  ["Kan", "KS"],
  ["Ky", "KY"],
  ["La", "LA"],
  ["Mass", "MA"],
  ["Md", "MD"],
  ["Mich", "MI"],
  ["Minn", "MN"],
  ["Miss", "MS"],
  ["Mo", "MO"],
  ["Mont", "MT"],
  ["Neb", "NE"],
  ["Nev", "NV"],
  ["NH", "NH"],
  ["NJ", "NJ"],
  ["NM", "NM"],
  ["NY", "NY"],
  ["NC", "NC"],
  ["ND", "ND"],
  ["Okla", "OK"],
  ["Ore", "OR"],
  ["Pa", "PA"],
  ["RI", "RI"],
  ["SC", "SC"],
  ["SD", "SD"],
  ["Tenn", "TN"],
  ["Tex", "TX"],
  ["Vt", "VT"],
  ["Va", "VA"],
  ["Wash", "WA"],
  ["WVa", "WV"],
  ["Wis", "WI"],
  ["Wyo", "WY"],
  ["DC", "DC"],
  ["Penn", "PA"],
  ["Penna", "PA"],
];
for (const [abbr, code] of GPO) {
  // bare: a 2-letter abbreviation IS a code, so the engine's own normalizer already takes it
  resolves(abbr, code, abbr.length === 2 ? EXACT : ALIAS);
  resolves(abbr.toLowerCase(), code, abbr.length === 2 ? EXACT : ALIAS);
  // with the traditional period, in any case, padded
  resolves(`${abbr}.`, code, ALIAS);
  resolves(`${abbr.toLowerCase()}.`, code, ALIAS);
  resolves(`${abbr.toUpperCase()}.`, code, ALIAS);
  resolves(`  ${abbr}.  `, code, ALIAS);
}
for (const [dotted, code] of [
  ["N.H.", "NH"],
  ["N.J.", "NJ"],
  ["N.M.", "NM"],
  ["N.Y.", "NY"],
  ["N.C.", "NC"],
  ["N.D.", "ND"],
  ["R.I.", "RI"],
  ["S.C.", "SC"],
  ["S.D.", "SD"],
  ["D.C.", "DC"],
  ["W.Va.", "WV"],
  ["Calif.,", "CA"],
]) {
  resolves(dotted, code, ALIAS);
}
// punctuation / whitespace folding of full names and codes (still deterministic, still not fuzzy)
resolves("US Virgin Islands", "VI", ALIAS);
resolves("new  york", "NY", ALIAS);
resolves("Texas.", "TX", ALIAS);
resolves("North   Carolina", "NC", ALIAS);
resolves("West Virginia,", "WV", ALIAS);
resolves("T.X.", "TX", ALIAS);
resolves("Tx.", "TX", ALIAS);

// Rule 3 — ONE trailing zip and/or country token, only when the remainder is then a state.
for (const input of [
  "TX 77001",
  "tx 77001",
  "TX, 77001",
  "TX 77001-1234",
  "  TX   77001  ",
  "Texas, USA",
  "Texas USA",
  "Texas,USA",
  "Texas, U.S.A.",
  "Texas, U.S.",
  "Texas, US",
  "Texas, United States",
  "Texas, United States of America",
  "TX 77001 USA",
  "TX, 77001, US",
  "TX USA 77001",
]) {
  resolves(input, "TX", ALIAS);
}
resolves("N.Y. 10001", "NY", ALIAS);
resolves("Calif. 90001", "CA", ALIAS);
resolves("Wash 98101", "WA", ALIAS);
resolves("West Virginia 25301 USA", "WV", ALIAS);

// Empty
for (const input of ["", "   ", "\t\n", NBSP, `${NBSP}${NBSP}`, null, undefined]) {
  unresolved(input, "EMPTY");
}

// Junk / near-misses — NEVER guessed, no fuzzy matching of any kind.
for (const input of [
  "Tejas",
  "Texs",
  "Texass",
  "Tx x",
  "T X",
  "Californa",
  "Calfornia",
  "Flordia",
  "New Yrok",
  "Massachusets",
  "Pennsylvannia",
  "West Virgina",
  "Cal",
  "the great state of texas",
  // not a state
  "N/A",
  "n/a",
  "Unknown",
  "none",
  "-",
  "?",
  "123",
  "XX",
  "ZZ",
  "UK",
  "ON",
  "BC",
  "AA",
  "AE",
  "AP",
  "FM",
  // several / decorated
  "TX/OK",
  "TX OK",
  "Texas or Oklahoma",
  "Houston TX 77001",
  "Houston, TX",
  "Springfield IL",
  "123 Main St TX",
  "St. Louis",
  "77001 TX",
  // a zip / country token alone, or malformed, is not a state
  "US",
  "USA",
  "United States",
  "77001",
  "77001-1234",
  "TX 7700",
  "TX 770012",
  "TX 77001 Houston",
  "TX 77001 77002",
  "TX USA USA",
  "texas texas",
  // Washington is ambiguous between the state and the city: never resolved through a comma
  "Washington DC",
  "Washington, DC",
  "Washington, DC 20001",
  // spaced abbreviations are not in the table
  "N. Y.",
  "W. Va.",
  // look-alike characters are not folded
  FULLWIDTH_TX,
  `T${ZWSP}X`,
  ZWSP,
  // prototype keys must miss (Map lookups, not object properties)
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
]) {
  unresolved(input, "UNPARSEABLE");
}

describe("normalize-address-states — local classification (rules 1-4)", () => {
  let out: Outcome[];
  beforeAll(() => {
    out = evaluate(
      LOCAL.map((c) => call("classifyLocal", ...(c.input === undefined ? [] : [c.input]))),
    );
  });

  it("L0: the table is big enough to mean something (every state x 11 spellings, plus the rest)", () => {
    expect(LOCAL.length).toBeGreaterThan(US_STATES.length * 11 + GPO.length * 6 + 60);
    expect(out).toHaveLength(LOCAL.length);
  });

  it("L1: every case resolves to exactly the expected code + verdict, or exactly the expected reason", () => {
    const mismatches: string[] = [];
    LOCAL.forEach((c, i) => {
      const o = out[i];
      const label = JSON.stringify(c.input);
      if (!o.ok) return void mismatches.push(`${label}: threw ${o.message}`);
      if (c.reason) {
        if (o.value.resolved !== false || o.value.reason !== c.reason) {
          mismatches.push(
            `${label}: expected UNRESOLVED:${c.reason}, got ${JSON.stringify(o.value)}`,
          );
        }
      } else if (
        o.value.resolved !== true ||
        o.value.stateCode !== c.code ||
        o.value.verdict !== c.verdict
      ) {
        mismatches.push(
          `${label}: expected ${c.verdict} ${c.code}, got ${JSON.stringify(o.value)}`,
        );
      }
    });
    expect(mismatches).toEqual([]);
  });

  it("L2: a resolved value is always a real US state code; an unresolved one never carries a code", () => {
    const codes = new Set(US_STATES.map((s) => s.code));
    for (const o of out) {
      if (o.value.resolved) expect(codes.has(o.value.stateCode)).toBe(true);
      else expect(o.value.stateCode).toBeUndefined();
    }
  });

  it("L3: RESOLVED_LOCAL_EXACT is exactly the cases the engine's own normalizer accepts", () => {
    // EXACT <=> rule "exact"; nothing folded or stripped may be labelled EXACT.
    for (const o of out) {
      if (o.value.resolved) {
        expect(o.value.verdict === EXACT).toBe(o.value.rule === "exact");
      }
    }
  });

  it("L4: the fold and strip primitives", () => {
    const o = evaluate([
      call("foldState", "  N.Y.  "),
      call("foldState", "Texas,USA"),
      call("foldState", "A \t\n  B"),
      call("foldState", ""),
      call("stripTrailingZipCountry", "tx 77001"),
      call("stripTrailingZipCountry", "tx"),
      call("stripTrailingZipCountry", "77001"),
      call("stripTrailingZipCountry", "us"),
      call("stripTrailingZipCountry", ""),
      call("stripTrailingZipCountry", "texas united states of america"),
    ]);
    expect(o.map((x) => x.value)).toEqual([
      "ny",
      "texas usa",
      "a b",
      "",
      "tx",
      null, // nothing removed
      null, // nothing left
      null, // nothing left
      null,
      "texas",
    ]);
  });
});

describe("normalize-address-states — the alias table and constants", () => {
  let o: Outcome[];
  beforeAll(() => {
    o = evaluate([
      get("STATE_ALIASES"),
      get("REASONS"),
      get("GOOGLE_ELIGIBLE_LOCAL_REASONS"),
      get("GOOGLE_ENDPOINT"),
      get("GOOGLE_DEFAULT_MAX"),
      get("GOOGLE_HARD_MAX"),
      get("RAW_STATE_DISPLAY_MAX"),
      get("TABLE"),
    ]);
  });

  it("A1: the alias table is exactly the documented GPO/AP list — nothing added, nothing missing", () => {
    const expected = GPO.map(([abbr, code]) => [abbr.toLowerCase(), code]).sort();
    expect([...(o[0].value as [string, string][])].sort()).toEqual(expected);
  });

  it("A2: every alias is folded (lowercase letters only) and targets a real state code", () => {
    const codes = new Set(US_STATES.map((s) => s.code));
    for (const [alias, code] of o[0].value as [string, string][]) {
      expect(alias).toMatch(/^[a-z]+$/);
      expect(codes.has(code)).toBe(true);
    }
    const aliases = (o[0].value as [string, string][]).map(([a]) => a);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("A3: constants the owner-facing contract names", () => {
    expect(o[1].value).toEqual([
      "EMPTY",
      "UNPARSEABLE",
      "NEEDS_GOOGLE",
      "GOOGLE_NO_MATCH",
      "GOOGLE_INCOMPLETE",
      "GOOGLE_ERROR",
      "NULL_TENANT",
    ]);
    // EMPTY is never sent to Google: there is nothing to normalize and any answer is an inference
    expect(o[2].value).toEqual(["UNPARSEABLE"]);
    expect(o[3].value).toBe("https://addressvalidation.googleapis.com/v1:validateAddress");
    expect(o[4].value).toBe(200);
    expect(o[5].value).toBe(2000);
    expect(o[6].value).toBe(40);
    expect(o[7].value).toBe("CustomerAddress");
  });
});

// ─── G: the Google leg, against a fake fetch ──────────────────────────────────────────────────

type Row = Record<string, unknown>;
const row = (n: number, over: Row = {}): Row => ({
  id: id(n),
  tenantId: TENANT_A,
  tenantSlug: "qa-nas",
  state: "Tejas",
  stateNeedsReview: false,
  googleSendable: true,
  line1: FIXTURE.line1,
  city: FIXTURE.city,
  zip: FIXTURE.zip,
  ...over,
});

/** Pass as `region` to leave `regionCode` OUT of the response entirely (`undefined` would trigger the default). */
const OMIT_REGION = Symbol("omit-regionCode");
const complete = (area: unknown, extra: Row = {}, region: unknown = "US") => ({
  status: 200,
  body: {
    result: {
      verdict: { addressComplete: true },
      address: {
        postalAddress: {
          ...(region === OMIT_REGION ? {} : { regionCode: region }),
          administrativeArea: area,
        },
      },
      ...extra,
    },
  },
});

const gcfg = (script: unknown[], extra: Row = {}) => ({
  apiKey: KEY,
  max: 200,
  timeoutMs: 2000,
  script,
  ...extra,
});
const batch = (rows: Row[], google: unknown = null) => ({ kind: "batch", rows, google });

type Report = {
  id: string;
  verdict: string;
  stateCode: string | null;
  reason: string | null;
  rule: string | null;
  rawState?: string;
  googleError?: string;
};
const reportsOf = (o: Outcome): Report[] => o.value.reports as Report[];

describe("normalize-address-states — the Google leg (fake fetch, never the network)", () => {
  it("G1: a complete US answer resolves the row, and the request is exactly the documented one", () => {
    const [o] = evaluate([batch([row(1)], gcfg([complete("TX")]))]);

    expect(o.ok).toBe(true);
    const [r] = reportsOf(o);
    expect(r).toMatchObject({
      id: id(1),
      verdict: "RESOLVED_GOOGLE",
      stateCode: "TX",
      reason: null,
      rule: "google",
    });
    // resolved rows never carry the raw state text
    expect(r.rawState).toBeUndefined();
    expect(o.value.google).toMatchObject({ enabled: true, needed: 1, attempted: 1, resolved: 1 });

    expect(o.calls).toHaveLength(1);
    const [c] = o.calls;
    // L-188: the key rides in a header, NEVER in the URL.
    expect(c.url).toBe("https://addressvalidation.googleapis.com/v1:validateAddress");
    expect(c.url).not.toContain(KEY);
    expect(c.url).not.toContain("key=");
    expect(c.method).toBe("POST");
    expect(c.headers).toEqual({ "Content-Type": "application/json", "X-Goog-Api-Key": KEY });
    expect(JSON.parse(c.body as string)).toEqual({
      address: {
        regionCode: "US",
        addressLines: [FIXTURE.line1, `${FIXTURE.city}, Tejas ${FIXTURE.zip}`],
      },
    });
  });

  it("G2: the administrativeArea may be a code or a name, in any case", () => {
    const o = evaluate([
      batch([row(1)], gcfg([complete("TX")])),
      batch([row(1)], gcfg([complete("Texas")])),
      batch([row(1)], gcfg([complete("tx")])),
      batch([row(1)], gcfg([complete("  DC ")])),
    ]);
    expect(o.map((x) => reportsOf(x)[0].stateCode)).toEqual(["TX", "TX", "TX", "DC"]);
  });

  it("G3: an address that is not COMPLETE is never accepted, whatever state it names", () => {
    const body = (verdict: unknown) => ({
      status: 200,
      body: {
        result: {
          verdict,
          address: { postalAddress: { regionCode: "US", administrativeArea: "TX" } },
        },
      },
    });
    const o = evaluate([
      batch([row(1)], gcfg([body({ addressComplete: false })])),
      batch([row(1)], gcfg([body({})])),
      batch([row(1)], gcfg([body(null)])),
      batch([row(1)], gcfg([body({ addressComplete: "true" })])),
      batch([row(1)], gcfg([body({ addressComplete: 1 })])),
      batch([row(1)], gcfg([body({ hasUnconfirmedComponents: true })])),
    ]);
    for (const x of o) {
      const [r] = reportsOf(x);
      expect(r.verdict).toBe("UNRESOLVED:GOOGLE_INCOMPLETE");
      expect(r.stateCode).toBeNull();
      expect(r.reason).toBe("GOOGLE_INCOMPLETE");
    }
  });

  it("G4: a complete answer with no usable US state is NO_MATCH — never a guess", () => {
    const o = evaluate([
      batch([row(1)], gcfg([complete(undefined)])),
      batch([row(1)], gcfg([complete(""), complete("")])),
      batch([row(1)], gcfg([complete(null)])),
      batch([row(1)], gcfg([complete(5)])),
      batch([row(1)], gcfg([complete("ON")])), // Ontario
      batch([row(1)], gcfg([complete("Tejas")])),
      batch([row(1)], gcfg([complete("WA", {}, "AU")])), // Western Australia is not Washington
      batch([row(1)], gcfg([{ status: 200, body: {} }])),
      batch([row(1)], gcfg([{ status: 200, body: { result: null } }])),
      batch([row(1)], gcfg([{ status: 200, body: [] }])),
      batch([row(1)], gcfg([{ status: 200, body: null }])),
      batch([row(1)], gcfg([{ status: 200, body: "str" }])),
    ]);
    for (const x of o) {
      const [r] = reportsOf(x);
      expect(r.verdict).toBe("UNRESOLVED:GOOGLE_NO_MATCH");
      expect(r.stateCode).toBeNull();
    }
  });

  it("G5 (review round 1, fail-open): an ABSENT or null regionCode is refused — only an explicit US answer is accepted, so an omitted country can never turn an Australian WA into Washington", () => {
    const o = evaluate([
      batch([row(1)], gcfg([complete("WA", {}, OMIT_REGION)])),
      batch([row(1)], gcfg([complete("WA", {}, null)])),
      batch([row(1)], gcfg([complete("WA", {}, "AU")])),
    ]);
    for (const x of o) {
      const [r] = reportsOf(x);
      expect(r.stateCode).toBeNull();
      expect(r.verdict).toBe("UNRESOLVED:GOOGLE_NO_MATCH");
    }
    // and an explicit US answer still resolves
    const [ok] = evaluate([batch([row(1)], gcfg([complete("WA", {}, "US")]))]);
    expect(reportsOf(ok)[0].stateCode).toBe("WA");
  });

  it("G6: an HTTP error is GOOGLE_ERROR with only the status code, and never throws out of the run", () => {
    const o = evaluate(
      [400, 403, 429, 500, 503].map((status) => batch([row(1)], gcfg([{ status, body: {} }]))),
    );
    o.forEach((x, i) => {
      expect(x.ok).toBe(true);
      const [r] = reportsOf(x);
      expect(r).toMatchObject({
        verdict: "UNRESOLVED:GOOGLE_ERROR",
        reason: "GOOGLE_ERROR",
        stateCode: null,
        googleError: `http-${[400, 403, 429, 500, 503][i]}`,
      });
      expect(x.value.google.errors).toEqual({ [`http-${[400, 403, 429, 500, 503][i]}`]: 1 });
    });
  });

  it("G7: a timeout, a network failure and an unreadable body are unresolved rows, never exceptions", () => {
    const o = evaluate([
      batch([row(1)], gcfg([{ hang: true }], { timeoutMs: 25 })),
      batch([row(1)], gcfg([{ throwName: "TimeoutError" }])),
      batch([row(1)], gcfg([{ throwName: "AbortError" }])),
      batch([row(1)], gcfg([{ throwName: "Error", message: "connect ECONNREFUSED" }])),
      batch([row(1)], gcfg([{ badJson: true }])),
    ]);
    expect(o.map((x) => x.ok)).toEqual([true, true, true, true, true]);
    expect(o.map((x) => reportsOf(x)[0].googleError)).toEqual([
      "timeout",
      "timeout",
      "timeout",
      "network",
      "invalid-response",
    ]);
    for (const x of o) expect(reportsOf(x)[0].verdict).toBe("UNRESOLVED:GOOGLE_ERROR");
  });

  it("G8: one failing row does not stop the rest — and results stay in row order", () => {
    const [o] = evaluate([
      batch(
        [row(1), row(2), row(3)],
        gcfg([{ status: 500, body: {} }, complete("TX"), complete("CA", { verdict: null })]),
      ),
    ]);
    expect(reportsOf(o).map((r) => r.verdict)).toEqual([
      "UNRESOLVED:GOOGLE_ERROR",
      "RESOLVED_GOOGLE",
      "UNRESOLVED:GOOGLE_INCOMPLETE",
    ]);
    expect(reportsOf(o).map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(o.calls).toHaveLength(3);
    expect(o.value.google).toMatchObject({ needed: 3, attempted: 3, resolved: 1 });
  });

  it("G9: the cap is a refusal raised BEFORE any request, never a silent truncation", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
    const over = evaluate([
      batch(rows(3), gcfg([complete("TX")], { max: 2 })),
      // no explicit max -> the default of 200
      batch(rows(201), gcfg([complete("TX")], { max: undefined })),
    ]);
    expect(over[0].ok).toBe(false);
    expect(over[0].name).toBe("GoogleCapExceededError");
    expect(over[0].message).toContain("3 address(es)");
    expect(over[0].message).toContain("--google-max is 2");
    expect(over[0].message).toContain("nothing was sent");
    expect(over[0].calls).toHaveLength(0);
    expect(over[1].ok).toBe(false);
    expect(over[1].message).toContain("--google-max is 200");
    expect(over[1].calls).toHaveLength(0);

    const atCap = evaluate([batch(rows(3), gcfg([complete("TX")], { max: 3 }))]);
    expect(atCap[0].ok).toBe(true);
    expect(atCap[0].calls).toHaveLength(3);
  });

  it("G10: only rows that genuinely need Google are sent", () => {
    const rows = [
      row(1, { state: "Texas" }), // resolved locally
      row(2, { state: "   " }), // EMPTY — never sent
      row(3, { tenantId: null, tenantSlug: null }), // NULL tenant — never sent
      row(4, { googleSendable: false }), // not enough address to send
      row(5), // the ONE that needs Google
      row(6, { state: "TX 77001" }), // resolved locally (stripped)
    ];
    const [withGoogle, without] = evaluate([
      batch(rows, gcfg([complete("OK")])),
      batch(rows, null),
    ]);

    expect(withGoogle.calls).toHaveLength(1);
    expect(reportsOf(withGoogle).map((r) => r.verdict)).toEqual([
      "RESOLVED_LOCAL_EXACT",
      "UNRESOLVED:EMPTY",
      "UNRESOLVED:NULL_TENANT",
      "UNRESOLVED:UNPARSEABLE",
      "RESOLVED_GOOGLE",
      "RESOLVED_LOCAL_ALIAS",
    ]);
    expect(reportsOf(withGoogle)[4].stateCode).toBe("OK");

    // without --google nothing is attempted and the row that WOULD need it says so
    expect(without.calls).toHaveLength(0);
    expect(without.value.google).toMatchObject({ enabled: false, needed: 1, attempted: 0 });
    expect(reportsOf(without).map((r) => r.verdict)).toEqual([
      "RESOLVED_LOCAL_EXACT",
      "UNRESOLVED:EMPTY",
      "UNRESOLVED:NULL_TENANT",
      "UNRESOLVED:UNPARSEABLE",
      "UNRESOLVED:NEEDS_GOOGLE",
      "RESOLVED_LOCAL_ALIAS",
    ]);
  });

  it("G11: the request body carries ONLY region + two address lines — no other row field", () => {
    const dirty = row(7, {
      line2: FIXTURE.line2,
      businessName: FIXTURE.businessName,
      email: FIXTURE.email,
      lat: FIXTURE.lat,
      lng: FIXTURE.lng,
      phone: "555-0100",
    });
    const [o, bare] = evaluate([
      batch([dirty], gcfg([complete("TX")])),
      // a row with a blank city still builds a sane second line, and a padded line1 is trimmed
      batch([row(8, { city: "  ", line1: `  ${FIXTURE.line1}  ` })], gcfg([complete("TX")])),
    ]);
    const sent = o.calls[0].body as string;
    const body = JSON.parse(sent);
    expect(Object.keys(body)).toEqual(["address"]);
    expect(Object.keys(body.address)).toEqual(["regionCode", "addressLines"]);
    expect(body.address.regionCode).toBe("US");
    expect(body.address.addressLines).toHaveLength(2);
    for (const forbidden of [
      FIXTURE.line2,
      FIXTURE.businessName,
      FIXTURE.email,
      String(FIXTURE.lat),
      String(FIXTURE.lng),
      "555-0100",
      TENANT_A,
      id(7),
      "qa-nas",
    ]) {
      expect(sent).not.toContain(forbidden);
    }
    expect(JSON.parse(bare.calls[0].body as string).address.addressLines).toEqual([
      FIXTURE.line1,
      `Tejas ${FIXTURE.zip}`,
    ]);
  });

  it("G12: the key never reaches a report, a prose line, the JSON or an error — even when fetch throws it", () => {
    const leaky = {
      throwName: "Error",
      message: `request to https://addressvalidation.googleapis.com/v1:validateAddress?key=${KEY} failed`,
    };
    const outcomes = evaluate([
      {
        kind: "pipeline",
        rows: [row(1), row(2), row(3)],
        google: gcfg([leaky, complete("TX"), { status: 403 }]),
      },
      { kind: "pipeline", rows: [row(1)], google: gcfg([complete("TX")]) },
      batch([row(1), row(2), row(3)], gcfg([complete("TX")], { max: 1 })), // cap error
    ]);
    for (const x of outcomes) {
      // `calls` legitimately holds the outgoing URL; everything the tool can PRINT must be clean
      const printable = JSON.stringify({
        ok: x.ok,
        value: x.value,
        name: x.name,
        message: x.message,
      });
      expect(printable).not.toContain(KEY);
      expect(printable).not.toContain(encodeURIComponent(KEY));
      expect(printable).not.toContain("key=");
      expect(printable).not.toContain("googleapis.com");
    }
  });
});

// ─── O: output discipline ─────────────────────────────────────────────────────────────────────

describe("normalize-address-states — output discipline", () => {
  const dirty = (n: number, over: Row = {}) =>
    row(n, {
      line2: FIXTURE.line2,
      businessName: FIXTURE.businessName,
      email: FIXTURE.email,
      lat: FIXTURE.lat,
      lng: FIXTURE.lng,
      ...over,
    });

  it("O1: no address line, city, zip, coordinate, name or email appears in any line, the summary or the JSON", () => {
    const [o] = evaluate([
      {
        kind: "pipeline",
        rows: [
          dirty(1, { state: " Texas " }), // exact
          dirty(2, { state: "Calif." }), // alias
          dirty(3, { state: "Tejas" }), // -> Google resolves
          dirty(4, { state: "Springfield" }), // -> Google says incomplete
          dirty(5, { state: "" }), // EMPTY
          dirty(6, { tenantId: null, tenantSlug: null, state: "Texs" }), // NULL tenant
          dirty(7, { state: "Nowhere", stateNeedsReview: true }), // already flagged
        ],
        google: gcfg([
          complete("TX"),
          { status: 200, body: { result: { verdict: { addressComplete: false } } } },
          { status: 500 },
        ]),
      },
    ]);
    expect(o.ok).toBe(true);
    const everything = `${o.value.lines.join("\n")}\n${o.value.json}\n${JSON.stringify(o.value.summary)}`;
    for (const secret of [
      FIXTURE.line1,
      FIXTURE.line2,
      FIXTURE.city,
      FIXTURE.zip,
      FIXTURE.businessName,
      FIXTURE.email,
      String(FIXTURE.lat),
      String(FIXTURE.lng),
      KEY,
    ]) {
      expect(everything).not.toContain(secret);
    }
    // ids, tenant ids, verdicts and codes ARE printed
    expect(o.value.lines[0]).toContain(`id=${id(1)}`);
    expect(o.value.lines[0]).toContain(`tenantId=${TENANT_A}`);
    expect(o.value.lines[0]).toContain("[RESOLVED_LOCAL_EXACT]");
    expect(o.value.lines[0]).toContain("stateCode=TX");
  });

  it("O2: the raw state text is shown ONLY for unresolved rows — a resolved row never echoes it", () => {
    const [o] = evaluate([
      {
        kind: "pipeline",
        rows: [
          row(1, { state: "  Texas  " }),
          row(2, { state: "Calif." }),
          row(3, { state: "Tejas" }),
          row(4, { state: "Nowhere" }),
        ],
        google: gcfg([complete("TX"), { status: 200, body: {} }]),
      },
    ]);
    const lines = o.value.lines as string[];
    expect(lines[0]).not.toContain("Texas");
    expect(lines[0]).not.toContain("state=");
    expect(lines[1]).not.toContain("Calif");
    expect(lines[2]).toContain("[RESOLVED_GOOGLE]"); // resolved by Google: raw text not echoed
    expect(lines[2]).not.toContain("Tejas");
    expect(lines[3]).toContain('state="Nowhere"');
    expect(lines[3]).toContain("[UNRESOLVED:GOOGLE_NO_MATCH]");
    // and the JSON rows follow the same rule
    const rows = JSON.parse(o.value.json).rows as Report[];
    expect(rows.map((r) => r.rawState)).toEqual([undefined, undefined, undefined, "Nowhere"]);
  });

  it("O3: the raw text is cut to 40 characters and escaped so it cannot spoof a terminal", () => {
    const long = "x".repeat(100);
    const emoji = String.fromCodePoint(0x1f600).repeat(45);
    const nasty = `a"b\\c${BEL}${RLO}${LSEP}z`;
    const [o, lines] = evaluate([
      batch([row(1, { state: long }), row(2, { state: emoji }), row(3, { state: nasty })], null),
      call("jsonToken", nasty),
    ]);
    const [a, b, c] = reportsOf(o);
    expect(a.rawState).toBe("x".repeat(40));
    expect(o.value.reports[0].rawStateTruncated).toBe(true);
    // 40 CODE POINTS, never half of a surrogate pair
    expect([...(b.rawState as string)]).toHaveLength(40);
    expect(Buffer.from(b.rawState as string, "utf8").toString("utf8")).toBe(b.rawState);
    // short values are not flagged
    expect(o.value.reports[2].rawStateTruncated).toBeUndefined();
    expect(c.rawState).toBe(nasty);

    // the prose token: JSON-escaped, C0 + bidi + line separators as text, quotes and backslashes escaped
    expect(lines.value).toBe(`"a\\"b\\\\c${U_ESC(7)}${U_ESC(0x202e)}${U_ESC(0x2028)}z"`);
    expect(lines.value).not.toContain(RLO);
    expect(lines.value).not.toContain(LSEP);
    expect(lines.value).not.toContain(BEL);
  });

  it("O4: a truncated value is marked, and the printed line stays bounded", () => {
    const [o] = evaluate([
      { kind: "pipeline", rows: [row(1, { state: "y".repeat(500) })], google: null },
    ]);
    const line = o.value.lines[0] as string;
    expect(line).toContain("(truncated)");
    expect(line).toContain(`state="${"y".repeat(40)}"`);
    expect(line).not.toContain("y".repeat(41));
  });

  it("O5: report lines follow the documented shape — id, tenantId, verdict, proposed code", () => {
    const [o] = evaluate([
      {
        kind: "pipeline",
        rows: [
          row(1, { state: "TX" }),
          row(2, { state: "Tejas" }),
          row(3, { state: "Tejas", stateNeedsReview: true }),
          row(4, { tenantId: null, tenantSlug: null, state: "Tejas" }),
        ],
        google: null,
      },
    ]);
    const lines = o.value.lines as string[];
    expect(lines[0]).toBe(
      `CustomerAddress  id=${id(1)}  tenantId=${TENANT_A}  tenantSlug=qa-nas  [RESOLVED_LOCAL_EXACT]  -> stateCode=TX`,
    );
    expect(lines[1]).toBe(
      `CustomerAddress  id=${id(2)}  tenantId=${TENANT_A}  tenantSlug=qa-nas  [UNRESOLVED:NEEDS_GOOGLE]  -> stateCode=-  state="Tejas"  (would flag stateNeedsReview)`,
    );
    expect(lines[2]).toContain("(already flagged for review)");
    expect(lines[3]).toBe(
      `CustomerAddress  id=${id(4)}  tenantId=-  [UNRESOLVED:NULL_TENANT]  -> stateCode=-  state="Tejas"  (never written)`,
    );
  });

  it("O6: the summary counts what it says", () => {
    const [o] = evaluate([
      {
        kind: "pipeline",
        rows: [
          row(1, { state: "TX" }),
          row(2, { state: "Calif." }),
          row(3, { state: "Tejas" }),
          row(4, { state: "Tejas", stateNeedsReview: true }),
          row(5, { state: "" }),
          row(6, { tenantId: null, tenantSlug: null }),
        ],
        google: null,
      },
    ]);
    expect(o.value.summary).toEqual({
      candidates: 6,
      resolvedLocalExact: 1,
      resolvedLocalAlias: 1,
      resolvedGoogle: 0,
      unresolved: 4,
      unresolvedByReason: { NEEDS_GOOGLE: 2, EMPTY: 1, NULL_TENANT: 1 },
      nullTenant: 1,
      alreadyFlagged: 1,
      toWrite: 4, // 2 resolved + row 3 flagged + row 5 (EMPTY) flagged; row 4 already flagged; row 6 never
      toSetState: 2,
      toFlag: 2,
    });
  });
});

// ─── U: the write list ────────────────────────────────────────────────────────────────────────

const SET_SQL =
  'UPDATE "CustomerAddress" SET "stateCode" = $1, "stateNeedsReview" = false, "updatedAt" = now() ' +
  'WHERE "id" = $2 AND "stateCode" IS NULL RETURNING "id"';
const FLAG_SQL =
  'UPDATE "CustomerAddress" SET "stateNeedsReview" = true, "updatedAt" = now() ' +
  'WHERE "id" = $1 AND "stateCode" IS NULL AND "stateNeedsReview" = false RETURNING "id"';

const rep = (n: number, over: Row = {}) => ({
  table: "CustomerAddress",
  id: id(n),
  tenantId: TENANT_A,
  tenantSlug: "qa-nas",
  verdict: "RESOLVED_LOCAL_EXACT",
  stateCode: "TX",
  reason: null,
  alreadyFlagged: false,
  ...over,
});
const unrep = (n: number, reason: string, over: Row = {}) =>
  rep(n, { verdict: `UNRESOLVED:${reason}`, stateCode: null, reason, ...over });

describe("normalize-address-states — buildUpdates (the write list)", () => {
  it("U1: one id-pinned, parameterized, still-NULL-guarded UPDATE per row that needs a write — nothing else", () => {
    const [o] = evaluate([
      call("buildUpdates", [
        rep(1),
        unrep(2, "UNPARSEABLE"),
        rep(3, { verdict: "RESOLVED_LOCAL_ALIAS", stateCode: "NY" }),
        unrep(4, "NULL_TENANT", { tenantId: null }),
        unrep(5, "NEEDS_GOOGLE", { alreadyFlagged: true }),
        rep(6, { verdict: "RESOLVED_GOOGLE", stateCode: "DC" }),
        unrep(7, "EMPTY"),
      ]),
    ]);

    expect(o.ok).toBe(true);
    expect(o.value).toEqual([
      {
        table: "CustomerAddress",
        id: id(1),
        tenantId: TENANT_A,
        action: "set-state",
        stateCode: "TX",
        sql: SET_SQL,
        params: ["TX", id(1)],
      },
      {
        table: "CustomerAddress",
        id: id(2),
        tenantId: TENANT_A,
        action: "flag-review",
        stateCode: null,
        sql: FLAG_SQL,
        params: [id(2)],
      },
      {
        table: "CustomerAddress",
        id: id(3),
        tenantId: TENANT_A,
        action: "set-state",
        stateCode: "NY",
        sql: SET_SQL,
        params: ["NY", id(3)],
      },
      {
        table: "CustomerAddress",
        id: id(6),
        tenantId: TENANT_A,
        action: "set-state",
        stateCode: "DC",
        sql: SET_SQL,
        params: ["DC", id(6)],
      },
      {
        table: "CustomerAddress",
        id: id(7),
        tenantId: TENANT_A,
        action: "flag-review",
        stateCode: null,
        sql: FLAG_SQL,
        params: [id(7)],
      },
    ]);
    // NULL-tenant row 4 and already-flagged row 5 produced nothing
  });

  it("U2: no statement is ever blanket, and an unresolved row can never receive a code", () => {
    const [o] = evaluate([
      call("buildUpdates", [rep(1), unrep(2, "UNPARSEABLE"), unrep(3, "GOOGLE_ERROR")]),
    ]);
    for (const u of o.value as { sql: string; action: string; params: string[] }[]) {
      expect(u.sql).toContain('WHERE "id" = $');
      expect(u.sql).toContain('"stateCode" IS NULL');
      expect(u.sql).toContain('RETURNING "id"');
      expect(u.sql).not.toMatch(/WHERE\s+"stateCode"/);
      if (u.action === "flag-review") {
        expect(u.sql).not.toContain('SET "stateCode"');
        expect(u.params).toHaveLength(1);
      }
    }
  });

  it("U3: a NULL-tenant row, an empty list and an all-annotated list yield an empty write list", () => {
    const o = evaluate([
      call("buildUpdates", []),
      call("buildUpdates", [unrep(1, "NULL_TENANT", { tenantId: null })]),
      call("buildUpdates", [unrep(1, "UNPARSEABLE", { alreadyFlagged: true })]),
      call("buildUpdates", undefined),
    ]);
    for (const x of o) expect(x.value ?? []).toEqual([]);
  });

  it("U4: a malformed batch throws instead of returning a half-safe list", () => {
    const bad = (r: Row, ...more: Row[]) => call("buildUpdates", [r, ...more]);
    const o = evaluate([
      bad(rep(1, { table: "Customer" })),
      bad(rep(1, { id: "" })),
      bad(rep(1), rep(1)), // duplicate id
      bad(rep(1, { stateCode: "ZZ" })),
      bad(rep(1, { stateCode: "tx" })),
      bad(rep(1, { stateCode: null })),
      bad(rep(1, { verdict: "RESOLVED_MAYBE" })),
      bad(rep(1, { tenantId: null })), // a resolved NULL-tenant row must never be written
      bad(unrep(1, "UNPARSEABLE", { stateCode: "TX" })), // unresolved carrying a code
      bad(unrep(1, "UNPARSEABLE", { tenantId: null })),
      bad({ ...unrep(1, "EMPTY"), reason: "UNPARSEABLE" }), // verdict / reason mismatch
      bad({ ...unrep(1, "EMPTY"), verdict: "UNRESOLVED:WHATEVER", reason: "WHATEVER" }),
      bad({ ...unrep(1, "EMPTY"), verdict: null }),
    ]);
    for (const x of o) {
      expect(x.ok).toBe(false);
      expect(x.message).toContain("address-state-normalize:");
    }
    expect(o[2].message).toContain("duplicate");
  });

  it("U5: the listing SQL selects address columns ONLY when Google needs them, and is scoped by slug", () => {
    const o = evaluate([
      call("candidateSql"),
      call("candidateSql", { withAddress: true }),
      call("candidateSql", { tenantScoped: true }),
      call("candidateSql", { withAddress: true, tenantScoped: true }),
    ]);
    const [plain, withAddr, scoped, both] = o.map((x) => x.value as string);

    for (const sql of [plain, withAddr, scoped, both]) {
      expect(sql.startsWith("SELECT ")).toBe(true);
      expect(sql).toContain('WHERE a."stateCode" IS NULL');
      expect(sql).toContain('LEFT JOIN "Tenant" t ON t."id" = a."tenantId"');
      expect(sql).toContain('ORDER BY a."createdAt", a."id"');
      expect(sql).toContain('AS "googleSendable"');
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    }
    // the report path never LOADS an address line, city or zip as a column
    expect(plain).not.toContain('a."line1" AS "line1"');
    expect(plain).not.toContain('AS "city"');
    expect(plain).not.toContain('AS "zip"');
    expect(plain).not.toContain("line2");
    expect(plain).not.toMatch(/"lat"|"lng"/);
    expect(plain).not.toContain("$1");
    // Google's request needs exactly these three, and nothing else
    for (const sql of [withAddr, both]) {
      expect(sql).toContain('a."line1" AS "line1"');
      expect(sql).toContain('a."city" AS "city"');
      expect(sql).toContain('a."zip" AS "zip"');
      expect(sql).not.toContain("line2");
      expect(sql).not.toMatch(/"lat"|"lng"/);
    }
    for (const sql of [scoped, both]) expect(sql).toContain('AND t."slug" = $1');
    expect(withAddr).not.toContain("$1");
  });
});

// ─── T: the --only-test-tenants guard ─────────────────────────────────────────────────────────

describe("normalize-address-states — assertTestTenantTargets (--only-test-tenants)", () => {
  const target = (n: number, tenantId: string | null) => ({
    table: "CustomerAddress",
    id: id(n),
    tenantId,
  });
  const guard = (rows: unknown[], slugById: Record<string, string | null>) =>
    call("assertTestTenantTargets", rows, slugById);

  it("T1: every approved test-tenant slug and pattern passes", () => {
    const [o] = evaluate([
      guard([target(1, TENANT_A), target(2, TENANT_B), target(3, "t3"), target(4, "t4")], {
        [TENANT_A]: "test",
        [TENANT_B]: "routeflow-demo",
        t3: "qa-nas-abc123",
        t4: "e2e-anything",
      }),
    ]);
    expect(o.ok).toBe(true);
    expect((o.value as { slug: string }[]).map((r) => r.slug)).toEqual([
      "test",
      "routeflow-demo",
      "qa-nas-abc123",
      "e2e-anything",
    ]);
  });

  it("T2: ONE offender refuses the WHOLE batch and every offender is listed", () => {
    const [o] = evaluate([
      guard([target(1, TENANT_A), target(2, TENANT_B), target(3, "t3")], {
        [TENANT_A]: "test",
        [TENANT_B]: "acme-widgets",
        t3: "zz-not-approved",
      }),
    ]);
    expect(o.ok).toBe(false);
    expect(o.message).toContain("normalize-address-states: --only-test-tenants refuses this batch");
    expect(o.message).toContain("2 of 3 target row(s)");
    expect(o.message).toContain(`CustomerAddress ${id(2)}`);
    expect(o.message).toContain("tenantSlug=acme-widgets");
    expect(o.message).toContain("tenantSlug=zz-not-approved");
    expect(o.message).not.toContain(`CustomerAddress ${id(1)}`); // the approved row is not an offender
    expect(o.message).toContain("NOTHING was written");
    expect(o.message).toContain("scripts/lib/test-tenants.cjs");
  });

  it("T3: an unresolvable tenant (no slug, or no tenant id at all) is an offender", () => {
    const o = evaluate([
      guard([target(1, TENANT_A)], { [TENANT_A]: null }),
      guard([target(1, TENANT_A)], {}),
      guard([target(1, null)], {}),
    ]);
    for (const x of o) {
      expect(x.ok).toBe(false);
      expect(x.message).toContain("tenantSlug=<unresolvable>");
    }
  });

  it("T4: the policy is never widened — near-miss slugs are client tenants", () => {
    const [o] = evaluate([
      guard([target(1, "a"), target(2, "b"), target(3, "c"), target(4, "d")], {
        a: "testing-co",
        b: "e2eclient",
        c: "ux-audit",
        d: "QA-Upper",
      }),
    ]);
    expect(o.ok).toBe(false);
    expect(o.message).toContain("4 of 4 target row(s)");
  });

  it("T5: an empty write list has nothing to refuse", () => {
    const [o] = evaluate([guard([], {})]);
    expect(o.ok).toBe(true);
    expect(o.value).toEqual([]);
  });
});

// ─── C: the CLI, spawned — argument validation must precede any connection ────────────────────

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  delete env.GOOGLE_MAPS_API_KEY;
  delete env.NORMALIZE_CONFIRM_TOKEN;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...env, DATABASE_URL: "postgres://x", ...extraEnv },
    timeout: 60_000,
  });
}

const NO_CONNECTION = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|reach database/i;

/** The CLI's non-comment lines — a claim in a comment must never satisfy a source pin. */
function cliCodeLines(): string {
  return fs
    .readFileSync(CLI, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    )
    .join("\n");
}

describe("normalize-address-states.mjs CLI contract", () => {
  const refused = (res: ReturnType<typeof runCli>) => {
    expect(res.status).toBe(2);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("refused before opening any connection");
    // "before connecting": DATABASE_URL points at a non-resolvable host, so a driver-level failure
    // would show up here if argument validation ran after the connection.
    expect(combined).not.toMatch(NO_CONNECTION);
    expect(res.stderr).not.toContain("Cannot find module");
    return combined;
  };

  it("C1: --live without --backup-attested exits 2 without attempting a connection", () => {
    expect(refused(runCli(["--live"]))).toContain("--backup-attested");
  });

  it("C2: an empty --backup-attested is not an attestation", () => {
    expect(refused(runCli(["--live", "--backup-attested", "   "]))).toContain("--backup-attested");
  });

  it("C3: --dry-run and --live together are refused before connecting", () => {
    const combined = refused(
      runCli(["--dry-run", "--live", "--backup-attested", "backup 2026-09-19"]),
    );
    expect(combined).toContain("mutually exclusive");
  });

  it("C4: --confirm without --only-test-tenants exits 2 (the unattended path exists only inside the guard)", () => {
    const combined = refused(
      runCli(["--live", "--backup-attested", "backup", "--confirm", "NORMALIZE 1 ADDRESSES"]),
    );
    expect(combined).toContain("--confirm");
    expect(combined).toContain("--only-test-tenants");
  });

  it("C5: --confirm with the guard still needs an attested backup", () => {
    const combined = refused(
      runCli(["--live", "--only-test-tenants", "--confirm", "NORMALIZE 1 ADDRESSES"]),
    );
    expect(combined).toContain("--backup-attested");
  });

  it("C5b: --json with an interactive --live is refused before connecting (the listing must be read BEFORE the confirmation prompt)", () => {
    const combined = refused(
      runCli(["--live", "--json", "--backup-attested", "backup 2026-09-19"]),
    );
    expect(combined).toContain("--json");
    expect(combined).toContain("interactive --live");
  });

  it("C6: --google without GOOGLE_MAPS_API_KEY exits 2 before any connection, and blank counts as absent", () => {
    const envs: Record<string, string>[] = [
      {},
      { GOOGLE_MAPS_API_KEY: "" },
      { GOOGLE_MAPS_API_KEY: "   " },
    ];
    for (const env of envs) {
      const combined = refused(runCli(["--google"], env));
      expect(combined).toContain("GOOGLE_MAPS_API_KEY");
    }
    // ...in every mode
    refused(runCli(["--google", "--dry-run"]));
    refused(runCli(["--google", "--live", "--backup-attested", "backup"]));
  });

  it("C7: --google-max needs --google, and must be a whole number in range", () => {
    refused(runCli(["--google-max", "5"]));
    for (const bad of ["0", "abc", "-5", "1.5", "2001", "", "1e3", " 5"]) {
      const combined = refused(
        runCli(["--google", "--google-max", bad], { GOOGLE_MAPS_API_KEY: KEY }),
      );
      expect(combined).toContain("--google-max");
      // a refusal never echoes the key
      expect(combined).not.toContain(KEY);
    }
    refused(runCli([`--google-max=abc`, "--google"], { GOOGLE_MAPS_API_KEY: KEY }));
  });

  it("C8: unknown flags are refused — including the never-implemented --apply", () => {
    for (const flag of ["--apply", "--force", "--yes", "--all-tenants", "-x"]) {
      expect(refused(runCli([flag]))).toContain(`unknown argument "${flag}"`);
    }
  });

  it("C9: --tenant-slug needs a real slug", () => {
    for (const args of [
      ["--tenant-slug"],
      ["--tenant-slug", ""],
      ["--tenant-slug=", "--dry-run"],
      ["--tenant-slug", "Test Tenant"],
      ["--tenant-slug", "UPPER"],
      ["--tenant-slug", "a;b"],
      ["--tenant-slug", "--live"],
      ["--tenant-slug", "-leading"],
    ]) {
      expect(refused(runCli(args))).toContain("--tenant-slug");
    }
  });

  it("C10: --help documents the modes, scope, Google, the guard, the phrase and the exit codes — and exits 0", () => {
    const res = runCli(["--help"]);

    expect(res.status).toBe(0);
    for (const needle of [
      "--dry-run",
      "--live",
      "--backup-attested",
      "--json",
      "--tenant-slug",
      "TEST TENANT FIRST",
      "--google",
      "--google-max",
      "GOOGLE_MAPS_API_KEY",
      "SENDS",
      "--only-test-tenants",
      '--confirm "<phrase>"',
      "scripts/lib/test-tenants.cjs",
      "NORMALIZE <n> ADDRESSES",
      "RESOLVED_LOCAL_EXACT",
      "RESOLVED_LOCAL_ALIAS",
      "RESOLVED_GOOGLE",
      "UNRESOLVED:<reason>",
      "NEEDS_GOOGLE",
      "NULL_TENANT",
      "NEVER guessed",
      "Exit codes",
    ]) {
      expect(res.stdout).toContain(needle);
    }
    expect(res.stdout).toMatch(/does NOT relax --backup-attested/);
    expect(res.stdout).toContain("--google-max exceeded");
  });

  it("C11: the header carries the production-safety rules and the four owner command lines", () => {
    const src = fs.readFileSync(CLI, "utf8");
    const header = src.slice(0, src.indexOf("import { createRequire }"));

    expect(header).toContain("PRODUCTION-SAFETY RULES");
    expect(header).toContain("OWNER-RUN ONLY");
    expect(header).toContain("Never run this from an implementation session");
    expect(header).toContain("NEVER a migration");
    expect(header).toContain("Take a FRESH backup first");
    expect(header).toContain("Run report, then `--dry-run`, then `--live`");
    expect(header).toContain("Output discipline");
    const cmd = "railway run --service postgres node apps/api/scripts/normalize-address-states.mjs";
    expect(header).toContain(`${cmd}\n`); // (a) report
    expect(header).toContain(`${cmd} --dry-run`); // (b)
    expect(header).toContain("--tenant-slug test --only-test-tenants --dry-run"); // (c) count
    expect(header).toContain("--tenant-slug test --only-test-tenants --live"); // (c) live
    expect(header).toContain('--confirm "NORMALIZE <n> ADDRESSES"');
    expect(header).toContain(`${cmd} --live \\`); // (d)
    expect(header).toContain("EXIT CODES");
  });

  it("C12: the session is read-only in code; the only writes are the lib's guarded statements", () => {
    const code = cliCodeLines();

    expect(code).toContain("default_transaction_read_only = on");
    // lifted only inside the --live path, after the typed confirmation
    expect(code).toContain("default_transaction_read_only = off");
    // only the pure module may build a write statement
    expect(code).not.toMatch(/UPDATE\s+"/);
    expect(code).not.toMatch(/\b(INSERT|DELETE)\s+(INTO|FROM)\b/i);
    // one transaction, checked row by row, rolled back (exit 4) when a row changed under us
    expect(code).toContain('await client.query("BEGIN")');
    expect(code).toContain("res.rows.length !== 1");
    expect(code).toContain('await client.query("ROLLBACK")');
    expect(code).toContain("return 4;");
  });

  it("C13: NORMALIZE_CONFIRM_TOKEN is gated on JEST_WORKER_ID and never relaxes the attestation", () => {
    const code = cliCodeLines();

    expect(code).toContain("process.env.JEST_WORKER_ID");
    expect(code).toContain("WARNING: test override NORMALIZE_CONFIRM_TOKEN active");
    expect(code).toContain("is ignored outside test");
    // the owner's --confirm wins over the test hook, and the phrase is still compared
    expect(code).toContain("opts.confirm !== null ? opts.confirm : confirmTokenOverride()");
    expect(code).toContain("answer.trim() !== phrase");
    // --live still refuses without an attested backup, token or no token
    expect(runCli(["--live"], { NORMALIZE_CONFIRM_TOKEN: "NORMALIZE 1 ADDRESSES" }).status).toBe(2);
  });

  it("C14: the guard resolves against the WRITE LIST, and the Google cap maps to exit 2", () => {
    const code = cliCodeLines();

    expect(code).toContain("assertTestTenantTargets(updates, slugById)");
    expect(code).toContain("e instanceof GoogleCapExceededError");
    // the refusal returns 2 from the same catch that prints the (key-free) message
    expect(code).toMatch(
      /GoogleCapExceededError\)\s*\{\s*console\.error\(e\.message\);\s*return 2;/,
    );
    // a tenant-scoped run binds the slug as a parameter, never by string concatenation
    expect(code).toContain('SELECT "id" FROM "Tenant" WHERE "slug" = $1');
    expect(code).toContain("tenantScoped: opts.tenantSlug !== null");
  });

  it("C15: output discipline holds in the CLI's own code", () => {
    const code = cliCodeLines();

    // the CLI never reads an address line, city, zip, coordinate or the raw state off a row —
    // it only hands rows to the lib and prints what the lib's formatter returns
    expect(code).not.toMatch(/\.(line1|line2|city|zip|lat|lng|state|businessName|email)\b/);
    // the key is passed to the lib and never printed, logged or interpolated into a message
    expect(code).not.toMatch(
      /(say|console\.(log|error|warn|info))\([^)]*(apiKey|GOOGLE_MAPS_API_KEY)/,
    );
    expect(code).not.toMatch(/\$\{[^}]*(apiKey|GOOGLE_MAPS_API_KEY)[^}]*\}/);
    // the connection URL is reduced to host + database
    expect(code).not.toMatch(/console\.(log|error)\([^)]*databaseUrl/);
  });
});
