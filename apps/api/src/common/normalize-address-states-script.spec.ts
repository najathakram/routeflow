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
  // A military (AE) prefix on purpose: `zip3States` has NO answer for 099, so the cross-check is a
  // no-op and every case that is not ABOUT the cross-check keeps its meaning. Cross-check cases
  // pass their own real zips.
  zip: "09909",
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
    if (step.forbidden) throw new Error("FORBIDDEN: fetch was called");
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
    if (c.kind === "apply") {
      // A recording fake of a pg client: \`c.results[n]\` is the row count the n-th statement that
      // carries params returns; \`c.throwAt\` is the (0-based) index of a query that throws.
      const queries = [];
      let nth = 0;
      const client = {
        query: async (sql, params) => {
          queries.push({ sql, params: params || null });
          if (c.throwAt === queries.length - 1) throw new Error("boom");
          if (!params) return { rows: [] };
          const n = c.results[nth++];
          return { rows: Array.from({ length: n === undefined ? 1 : n }, () => ({ id: "x" })) };
        },
      };
      try {
        const result = await lib.applyUpdates(client, c.updates);
        return { ok: true, value: { result, queries }, calls };
      } catch (e) {
        return { ok: false, name: e.name, message: e.message, calls, value: { queries } };
      }
    }
    if (c.kind === "batch" || c.kind === "pipeline" || c.kind === "plan") {
      const google = c.google
        ? {
            apiKey: c.google.apiKey,
            max: c.google.max,
            timeoutMs: c.google.timeoutMs,
            fetchImpl: makeFetch(c.google.script, calls),
          }
        : null;
      if (c.kind === "plan") {
        const batch = await lib.planRun(c.rows, {
          onlyTestTenants: c.onlyTestTenants,
          maxRows: c.maxRows,
          google,
          showUnresolvedText: c.showUnresolvedText,
        });
        return { ok: true, value: batch, calls };
      }
      const batch = await lib.classifyBatch(c.rows, {
        google,
        showUnresolvedText: c.showUnresolvedText,
      });
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
      get("DEFAULT_MAX_ROWS"),
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
      "NEEDS_ZIP",
      "AMBIGUOUS_NEEDS_ZIP",
      "GOOGLE_NO_MATCH",
      "GOOGLE_INCOMPLETE",
      "GOOGLE_INFERRED",
      "GOOGLE_ERROR",
      "ZIP_CONFLICT",
      "NULL_TENANT",
    ]);
    // EMPTY is never sent to Google: there is nothing to normalize and any answer is an inference
    expect(o[2].value).toEqual(["UNPARSEABLE"]);
    expect(o[3].value).toBe("https://addressvalidation.googleapis.com/v1:validateAddress");
    expect(o[4].value).toBe(200);
    expect(o[5].value).toBe(2000);
    expect(o[6].value).toBe(40);
    expect(o[7].value).toBe("CustomerAddress");
    expect(o[8].value).toBe(500);
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
/** One Address Validation v1 component: confirmed and untouched unless the case says otherwise. */
const component = (componentType: string, text: string, over: Row = {}) => ({
  componentName: { text },
  componentType,
  confirmationLevel: "CONFIRMED",
  ...over,
});
const goodComponents = (area: unknown) => [
  component("street_number", "9999"),
  component("locality", "Faketown"),
  component("administrative_area_level_1", String(area)),
  component("postal_code", "09909"),
];
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
        addressComponents: goodComponents(area),
      },
      ...extra,
    },
  },
});
/** A complete US answer whose component list (and/or verdict) is replaced by the case. */
const withComponents = (components: unknown, verdictExtra: Row = {}) => ({
  status: 200,
  body: {
    result: {
      verdict: { addressComplete: true, ...verdictExtra },
      address: {
        postalAddress: { regionCode: "US", administrativeArea: "TX" },
        ...(components === undefined ? {} : { addressComponents: components }),
      },
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
const batch = (rows: Row[], google: unknown = null, showUnresolvedText = false) => ({
  kind: "batch",
  rows,
  google,
  showUnresolvedText,
});

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
          dirty(2, { state: "Calif.", zip: "90001" }), // alias
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

  it("O2: the raw state text is NOT printed by default; with the opt-in it appears only on unresolved rows", () => {
    const pipeline = (showUnresolvedText: boolean) => ({
      kind: "pipeline",
      showUnresolvedText,
      rows: [
        row(1, { state: "  Texas  " }),
        row(2, { state: "Calif.", zip: "90001" }),
        row(3, { state: "Tejas" }),
        row(4, { state: "Nowhere" }),
      ],
      google: gcfg([complete("TX"), { status: 200, body: {} }]),
    });
    const [off, on] = evaluate([pipeline(false), pipeline(true)]);

    // DEFAULT: verdict + reason only — no raw text in a line or in the JSON rows
    const offLines = off.value.lines as string[];
    for (const line of offLines) expect(line).not.toContain("state=");
    expect(offLines.join("\n")).not.toContain("Nowhere");
    expect(offLines.join("\n")).not.toContain("Tejas");
    expect(offLines[3]).toContain("[UNRESOLVED:GOOGLE_NO_MATCH]");
    expect(JSON.parse(off.value.json).rows.map((r: Report) => r.rawState)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(off.value.json).not.toContain("rawState");

    // OPT-IN: only the UNRESOLVED row shows its text; a resolved row never echoes it
    const lines = on.value.lines as string[];
    expect(lines[0]).not.toContain("Texas");
    expect(lines[0]).not.toContain("state=");
    expect(lines[1]).not.toContain("Calif");
    expect(lines[2]).toContain("[RESOLVED_GOOGLE]"); // resolved by Google: raw text not echoed
    expect(lines[2]).not.toContain("Tejas");
    expect(lines[3]).toContain('state="Nowhere"');
    expect(lines[3]).toContain("[UNRESOLVED:GOOGLE_NO_MATCH]");
    const rows = JSON.parse(on.value.json).rows as Report[];
    expect(rows.map((r) => r.rawState)).toEqual([undefined, undefined, undefined, "Nowhere"]);
  });

  it("O3: the raw text is cut to 40 characters and escaped so it cannot spoof a terminal", () => {
    const long = "x".repeat(100);
    const emoji = String.fromCodePoint(0x1f600).repeat(45);
    const nasty = `a"b\\c${BEL}${RLO}${LSEP}z`;
    const [o, lines] = evaluate([
      batch(
        [row(1, { state: long }), row(2, { state: emoji }), row(3, { state: nasty })],
        null,
        true,
      ),
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
      {
        kind: "pipeline",
        showUnresolvedText: true,
        rows: [row(1, { state: "y".repeat(500) })],
        google: null,
      },
    ]);
    const line = o.value.lines[0] as string;
    expect(line).toContain("(truncated)");
    expect(line).toContain(`state="${"y".repeat(40)}"`);
    expect(line).not.toContain("y".repeat(41));
  });

  it("O5: report lines follow the documented shape — id, tenantId, verdict, proposed code (raw text only on request)", () => {
    const rows = [
      row(1, { state: "TX" }),
      row(2, { state: "Tejas" }),
      row(3, { state: "Tejas", stateNeedsReview: true }),
      row(4, { tenantId: null, tenantSlug: null, state: "Tejas" }),
    ];
    const [plain, shown] = evaluate([
      { kind: "pipeline", rows, google: null },
      { kind: "pipeline", rows, google: null, showUnresolvedText: true },
    ]);
    const lines = plain.value.lines as string[];
    expect(lines[0]).toBe(
      `CustomerAddress  id=${id(1)}  tenantId=${TENANT_A}  tenantSlug=qa-nas  [RESOLVED_LOCAL_EXACT]  -> stateCode=TX`,
    );
    expect(lines[1]).toBe(
      `CustomerAddress  id=${id(2)}  tenantId=${TENANT_A}  tenantSlug=qa-nas  [UNRESOLVED:NEEDS_GOOGLE]  -> stateCode=-  (would flag stateNeedsReview)`,
    );
    expect(lines[2]).toContain("(already flagged for review)");
    expect(lines[3]).toBe(
      `CustomerAddress  id=${id(4)}  tenantId=-  [UNRESOLVED:NULL_TENANT]  -> stateCode=-  (never written)`,
    );
    const withText = shown.value.lines as string[];
    expect(withText[1]).toBe(
      `CustomerAddress  id=${id(2)}  tenantId=${TENANT_A}  tenantSlug=qa-nas  [UNRESOLVED:NEEDS_GOOGLE]  -> stateCode=-  state="Tejas"  (would flag stateNeedsReview)`,
    );
    expect(withText[3]).toContain('state="Tejas"  (never written)');
  });

  it("O6: the summary counts what it says", () => {
    const [o] = evaluate([
      {
        kind: "pipeline",
        rows: [
          row(1, { state: "TX" }),
          row(2, { state: "Calif.", zip: "90001" }),
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
  'WHERE "id" = $2 AND "tenantId" = $3 AND "stateCode" IS NULL RETURNING "id"';
const FLAG_SQL =
  'UPDATE "CustomerAddress" SET "stateNeedsReview" = true, "updatedAt" = now() ' +
  'WHERE "id" = $1 AND "tenantId" = $2 AND "stateCode" IS NULL AND "stateNeedsReview" = false ' +
  'RETURNING "id"';

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
        params: ["TX", id(1), TENANT_A],
      },
      {
        table: "CustomerAddress",
        id: id(2),
        tenantId: TENANT_A,
        action: "flag-review",
        stateCode: null,
        sql: FLAG_SQL,
        params: [id(2), TENANT_A],
      },
      {
        table: "CustomerAddress",
        id: id(3),
        tenantId: TENANT_A,
        action: "set-state",
        stateCode: "NY",
        sql: SET_SQL,
        params: ["NY", id(3), TENANT_A],
      },
      {
        table: "CustomerAddress",
        id: id(6),
        tenantId: TENANT_A,
        action: "set-state",
        stateCode: "DC",
        sql: SET_SQL,
        params: ["DC", id(6), TENANT_A],
      },
      {
        table: "CustomerAddress",
        id: id(7),
        tenantId: TENANT_A,
        action: "flag-review",
        stateCode: null,
        sql: FLAG_SQL,
        params: [id(7), TENANT_A],
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
      // the tenant the listing (and the test-tenant gate) approved is re-stated in the write
      expect(u.sql).toContain('"tenantId" = $');
      expect(u.sql).toContain('"stateCode" IS NULL');
      expect(u.sql).toContain('RETURNING "id"');
      expect(u.sql).not.toMatch(/WHERE\s+"stateCode"/);
      if (u.action === "flag-review") {
        expect(u.sql).not.toContain('SET "stateCode"');
        expect(u.params).toHaveLength(2);
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

  it("U6: the new reasons are flag-only: a ZIP_CONFLICT / NEEDS_ZIP / GOOGLE_INFERRED row never receives a code", () => {
    const [o, carrying] = evaluate([
      call("buildUpdates", [
        unrep(1, "ZIP_CONFLICT"),
        unrep(2, "NEEDS_ZIP"),
        unrep(3, "GOOGLE_INFERRED"),
        unrep(4, "ZIP_CONFLICT", { alreadyFlagged: true }),
      ]),
      call("buildUpdates", [unrep(1, "ZIP_CONFLICT", { stateCode: "WA" })]),
    ]);
    expect((o.value as { action: string; id: string }[]).map((u) => [u.action, u.id])).toEqual([
      ["flag-review", id(1)],
      ["flag-review", id(2)],
      ["flag-review", id(3)],
    ]);
    // an unresolved row that somehow carries a code is refused, never written
    expect(carrying.ok).toBe(false);
    expect(carrying.message).toContain("is unresolved but carries a code");
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

// ─── Z: the ZIP3 -> state table ───────────────────────────────────────────────────────────────

describe("normalize-address-states — us-zip3 (the ZIP cross-check's data)", () => {
  // Well-known real ZIPs, restated INDEPENDENTLY of the table under test. Where a prefix genuinely
  // spans states the allowed set is a SUPERSET, so this checks membership, not equality.
  const KNOWN: Array<[string, string]> = [
    ["90210", "CA"],
    ["94105", "CA"],
    ["90012", "CA"],
    ["10001", "NY"],
    ["60601", "IL"],
    ["77001", "TX"],
    ["20001", "DC"],
    ["98101", "WA"],
    ["33101", "FL"],
    ["02101", "MA"],
    ["99501", "AK"],
    ["96801", "HI"],
    ["00901", "PR"],
    ["00801", "VI"],
    ["63101", "MO"],
    ["66101", "KS"],
    ["64101", "MO"],
    ["30301", "GA"],
    ["80202", "CO"],
    ["85001", "AZ"],
    ["55101", "MN"],
    ["48201", "MI"],
    ["19103", "PA"],
    ["21201", "MD"],
    ["23219", "VA"],
    ["27601", "NC"],
    ["29201", "SC"],
    ["35201", "AL"],
    ["37201", "TN"],
    ["39201", "MS"],
    ["40202", "KY"],
    ["43215", "OH"],
    ["46204", "IN"],
    ["50309", "IA"],
    ["53202", "WI"],
    ["57104", "SD"],
    ["58102", "ND"],
    ["59101", "MT"],
    ["68102", "NE"],
    ["70112", "LA"],
    ["72201", "AR"],
    ["73102", "OK"],
    ["82001", "WY"],
    ["83702", "ID"],
    ["84101", "UT"],
    ["87101", "NM"],
    ["89101", "NV"],
    ["97201", "OR"],
    ["04101", "ME"],
    ["03301", "NH"],
    ["05401", "VT"],
    ["06103", "CT"],
    ["07102", "NJ"],
    ["19901", "DE"],
    ["25301", "WV"],
    ["02903", "RI"],
    ["96910", "GU"],
    ["96950", "MP"],
    ["96799", "AS"],
    ["88510", "TX"], // El Paso sits in the 88x block
    ["73301", "TX"], // Austin IRS center sits in the 73x block
  ];

  it("Z1: every well-known ZIP maps to a set that contains its real state", () => {
    const o = evaluate(KNOWN.map(([zip]) => call("zip3States", zip)));
    const misses: string[] = [];
    KNOWN.forEach(([zip, code], i) => {
      const set = o[i].value as string[] | null;
      if (!set || !set.includes(code)) misses.push(`${zip} expected ${code}, got ${set}`);
    });
    expect(misses).toEqual([]);
  });

  it("Z2: a prefix that spans states lists every candidate; a single-state prefix lists one", () => {
    const o = evaluate([
      call("zip3States", "20001"),
      call("zip3States", "20166"),
      call("zip3States", "96799"),
      call("zip3States", "96910"),
      call("zip3States", "77001"),
      call("zip3States", "90210"),
    ]);
    expect(o[0].value).toEqual(expect.arrayContaining(["DC", "MD", "VA"]));
    expect(o[1].value).toEqual(expect.arrayContaining(["VA"]));
    expect(o[2].value).toEqual(expect.arrayContaining(["HI", "AS"]));
    expect(o[3].value).toEqual(expect.arrayContaining(["GU", "MP"]));
    expect(o[4].value).toEqual(["TX"]);
    expect(o[5].value).toEqual(["CA"]);
  });

  it("Z3: NO reliable state (military, unassigned, unparseable) is null — never an empty or wrong set", () => {
    const cases = [
      "09001", // AE military
      "09999",
      "34001", // AA military
      "96201", // AP military
      "96601",
      "00101", // unassigned
      "88801", // unassigned
      "45901", // not in the table: no data, not a conflict
      "",
      "   ",
      "1234",
      "123456",
      "abcde",
      "77O01", // letter O
      "77001-12", // malformed +4
      null,
      undefined,
      12345,
    ];
    const o = evaluate(cases.map((z) => call("zip3States", ...(z === undefined ? [] : [z]))));
    o.forEach((x, i) => expect([cases[i], x.value ?? null]).toEqual([cases[i], null]));
  });

  it("Z4: a ZIP+4, padding and a bare 3-digit prefix are understood", () => {
    const o = evaluate([
      call("zip3States", "77001-1234"),
      call("zip3States", "  77001  "),
      call("zip3States", "770"),
      call("zip3States", "\t90210\n"),
    ]);
    expect(o.map((x) => x.value)).toEqual([["TX"], ["TX"], ["TX"], ["CA"]]);
  });

  it("Z5: the table is sorted, non-overlapping, three-digit, and only names real state codes", () => {
    const [ranges] = evaluate([get("ZIP3_RANGES")]);
    const codes = new Set(US_STATES.map((s) => s.code));
    const table = ranges.value as Array<[string, string, string[]]>;
    let prevHigh = -1;
    for (const [low, high, states] of table) {
      expect(low).toMatch(/^\d{3}$/);
      expect(high).toMatch(/^\d{3}$/);
      expect(Number(low)).toBeLessThanOrEqual(Number(high));
      expect(Number(low)).toBeGreaterThan(prevHigh);
      prevHigh = Number(high);
      expect(states.length).toBeGreaterThan(0);
      expect(new Set(states).size).toBe(states.length);
      for (const code of states) expect(codes.has(code)).toBe(true);
    }
  });

  it("Z6: every state and territory the tool can resolve appears in the table", () => {
    const [ranges] = evaluate([get("ZIP3_RANGES")]);
    const seen = new Set<string>();
    for (const [, , states] of ranges.value as Array<[string, string, string[]]>) {
      for (const code of states) seen.add(code);
    }
    expect(US_STATES.map((s) => s.code).filter((c) => !seen.has(c))).toEqual([]);
  });

  it("Z7: the military and unassigned blocks are genuinely absent from the table", () => {
    const [ranges] = evaluate([get("ZIP3_RANGES")]);
    const covered = new Set<number>();
    for (const [low, high] of ranges.value as Array<[string, string, string[]]>) {
      for (let n = Number(low); n <= Number(high); n++) covered.add(n);
    }
    for (const n of [90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 340, 962, 963, 964, 965, 966]) {
      expect(covered.has(n)).toBe(false);
    }
  });
});

// ─── X: the ZIP cross-check on resolutions ────────────────────────────────────────────────────

describe("normalize-address-states — ZIP cross-check (a resolution must not contradict the row's zip)", () => {
  const plan = (rows: Row[], google: unknown = null) => ({ kind: "pipeline", rows, google });
  const zrow = (n: number, state: string, zip: string | null, over: Row = {}) =>
    row(n, { state, zip, googleSendable: false, ...over });

  it("X1: the named conflicts are ZIP_CONFLICT, flagged for review and never given a code", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Washington", "20001"), // bare Washington + a DC zip
        zrow(2, "L.A.", "90012"), // alias `la` = Louisiana, Los Angeles zip
        zrow(3, "Kansas", "64101"), // a Missouri zip
        zrow(4, "TX", "90210"), // even an exact code is checked
      ]),
    ]);
    const lines = o.value.lines as string[];
    const rows = JSON.parse(o.value.json).rows as Array<
      Report & { conflictCode: string; zipStates: string[] }
    >;
    expect(rows.map((r) => r.verdict)).toEqual(Array(4).fill("UNRESOLVED:ZIP_CONFLICT"));
    expect(rows.map((r) => r.stateCode)).toEqual([null, null, null, null]);
    expect(rows.map((r) => r.conflictCode)).toEqual(["WA", "LA", "KS", "TX"]);
    expect(rows[0].zipStates).toEqual(expect.arrayContaining(["DC"]));
    expect(rows[1].zipStates).toEqual(["CA"]);
    expect(rows[2].zipStates).toEqual(["MO"]);
    expect(lines[0]).toContain("[UNRESOLVED:ZIP_CONFLICT]");
    expect(lines[0]).toContain("conflict=WA");
    // never a code: the write list only FLAGS them
    expect(o.value.updates.map((u: { action: string }) => u.action)).toEqual(
      Array(4).fill("flag-review"),
    );
    expect(o.value.updates.every((u: { stateCode: unknown }) => u.stateCode === null)).toBe(true);
    expect(o.value.summary).toMatchObject({
      resolvedLocalExact: 0,
      resolvedLocalAlias: 0,
      unresolved: 4,
      unresolvedByReason: { ZIP_CONFLICT: 4 },
      toSetState: 0,
      toFlag: 4,
    });
    // a conflict line carries state CODES only — never the zip digits
    expect(lines.join("\n")).not.toMatch(/2000\d|9001\d|6410\d|9021\d/);
  });

  it("X2: an agreeing zip resolves as before (including the multi-state DC block and ZIP+4)", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Washington", "98101"),
        zrow(2, "DC", "20001"),
        zrow(3, "Virginia", "20166"), // a Dulles zip in the DC-block prefix
        zrow(4, "Maryland", "20852"),
        zrow(5, "N.Y.", "10001-1234"),
        zrow(6, "Kansas", "66101"),
        zrow(7, "Calif.", "90012"),
        zrow(8, "Tex", "77001"),
        zrow(9, "Hawaii", "96801"),
        zrow(10, "American Samoa", "96799"),
      ]),
    ]);
    const rows = JSON.parse(o.value.json).rows as Report[];
    expect(rows.map((r) => r.stateCode)).toEqual([
      "WA",
      "DC",
      "VA",
      "MD",
      "NY",
      "KS",
      "CA",
      "TX",
      "HI",
      "AS",
    ]);
    expect(rows.every((r) => r.reason === null)).toBe(true);
  });

  it("X3: for an UNAMBIGUOUS text, no zip / a blank / unparseable zip / a no-data prefix skips the check", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Idaho", ""),
        zrow(2, "Idaho", "   "),
        zrow(3, "Idaho", "2000"),
        zrow(4, "Idaho", "abcde"),
        zrow(5, "Idaho", "09001"), // military: no reliable state
        zrow(6, "Idaho", "00101"), // unassigned
        row(7, { state: "Idaho", zip: undefined, googleSendable: false }), // no zip at all
      ]),
    ]);
    const rows = JSON.parse(o.value.json).rows as Report[];
    expect(rows.map((r) => r.stateCode)).toEqual(Array(7).fill("ID"));
  });

  it("X4: the report path carries only the SQL's zip3 prefix — and it drives the same check", () => {
    const [o] = evaluate([
      plan([
        { ...zrow(1, "Washington", null), zip: undefined, zip3: "200" },
        { ...zrow(2, "Washington", null), zip: undefined, zip3: "981" },
        { ...zrow(3, "Washington", null), zip: undefined, zip3: null },
        { ...zrow(4, "Washington", null), zip: undefined, zip3: "099" },
      ]),
    ]);
    const rows = JSON.parse(o.value.json).rows as Report[];
    // "Washington" is AMBIGUOUS: only the confirming prefix (981) resolves; a DC prefix conflicts;
    // no prefix at all, or a military one, is AMBIGUOUS_NEEDS_ZIP — never a guessed WA.
    expect(rows.map((r) => r.verdict)).toEqual([
      "UNRESOLVED:ZIP_CONFLICT",
      "RESOLVED_LOCAL_EXACT",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
    ]);
    // neither the prefix nor a zip is ever placed on a report
    expect(o.value.json).not.toContain("zip3");
    expect(o.value.json).not.toContain('"zip"');
  });

  it("X5: a GOOGLE answer is cross-checked too — Google says TX for a New York zip", () => {
    const [o, ok] = evaluate([
      plan([row(1, { zip: "10001" })], gcfg([complete("TX")])),
      plan([row(1, { zip: "77001" })], gcfg([complete("TX")])),
    ]);
    expect(reportsOfPipeline(o)[0]).toMatchObject({
      verdict: "UNRESOLVED:ZIP_CONFLICT",
      stateCode: null,
      conflictCode: "TX",
    });
    expect(JSON.parse(o.value.json).google).toMatchObject({ attempted: 1, resolved: 0 }); // a conflict is not "resolved"
    expect(reportsOfPipeline(ok)[0]).toMatchObject({ verdict: "RESOLVED_GOOGLE", stateCode: "TX" });
    expect(JSON.parse(ok.value.json).google).toMatchObject({ attempted: 1, resolved: 1 });
  });

  it("X6: a zip written INSIDE the state text is cross-checked — a blank zip column hides nothing", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Washington 20001", ""), // WA + a DC zip, in the text only
        zrow(2, "Texas 90210", ""), // TX + a Beverly Hills zip
        zrow(3, "L.A. 90012", null), // alias `la` = Louisiana + a Los Angeles zip
        zrow(4, "Washington 20001", "98101"), // the column agrees with WA; the text contradicts it
        zrow(5, "Washington 98101", ""), // agrees
        zrow(6, "Texas 77001 USA", ""), // zip then country, agrees
        zrow(7, "Washington 98101", "20001"), // text agrees; the COLUMN contradicts it
      ]),
    ]);
    const rows = reportsOfPipeline(o);
    expect(rows.map((r) => r.verdict)).toEqual([
      "UNRESOLVED:ZIP_CONFLICT",
      "UNRESOLVED:ZIP_CONFLICT",
      "UNRESOLVED:ZIP_CONFLICT",
      "UNRESOLVED:ZIP_CONFLICT",
      "RESOLVED_LOCAL_ALIAS",
      "RESOLVED_LOCAL_ALIAS",
      "UNRESOLVED:ZIP_CONFLICT",
    ]);
    expect(rows.map((r) => r.conflictCode)).toEqual([
      "WA",
      "TX",
      "LA",
      "WA",
      undefined,
      undefined,
      "WA",
    ]);
    expect(rows[4].stateCode).toBe("WA");
    expect(rows[5].stateCode).toBe("TX");
    expect(rows[0].zipStates).toEqual(expect.arrayContaining(["DC"]));
    // the write list only ever FLAGS a conflict
    const actions = (o.value.updates as { action: string; stateCode: unknown }[]).map(
      (u) => `${u.action}:${u.stateCode}`,
    );
    expect(actions).toEqual([
      "flag-review:null",
      "flag-review:null",
      "flag-review:null",
      "flag-review:null",
      "set-state:WA",
      "set-state:TX",
      "flag-review:null",
    ]);
    // the embedded zip is never echoed on a report or a line
    expect(o.value.json).not.toMatch(/2000\d|9001\d|9021\d/);
  });

  it("X7: splitTrailingZipCountry keeps the zip it removes; stripTrailingZipCountry is its remainder", () => {
    const o = evaluate([
      call("splitTrailingZipCountry", "tx 77001"),
      call("splitTrailingZipCountry", "texas 77001 usa"),
      call("splitTrailingZipCountry", "texas usa"),
      call("splitTrailingZipCountry", "77001"),
      call("splitTrailingZipCountry", ""),
    ]);
    expect(o.map((x) => x.value)).toEqual([
      { remainder: "tx", zip: "77001" },
      { remainder: "texas", zip: "77001" },
      { remainder: "texas", zip: null },
      { remainder: null, zip: "77001" },
      { remainder: null, zip: null },
    ]);
  });

  // PC-lead ruling: ambiguous free text (a state name / abbreviation that is ALSO a city's) with a
  // blank, invalid or MILITARY zip is UNRESOLVED — never a guessed state.
  it("X8: an AMBIGUOUS text needs a CONFIRMING civilian zip — blank, invalid, military and unassigned zips leave it UNRESOLVED:AMBIGUOUS_NEEDS_ZIP", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Washington", ""), // blank zip
        zrow(2, "Washington", "   "),
        zrow(3, "Washington", "2000"), // invalid (4 digits)
        zrow(4, "Washington", "abcde"), // invalid
        zrow(5, "Washington", "09001"), // MILITARY (APO/FPO)
        zrow(6, "Washington", "96201"), // MILITARY (AP)
        zrow(7, "Washington", "00101"), // unassigned
        row(8, { state: "Washington", zip: undefined, googleSendable: false }), // no zip at all
        zrow(9, "L.A.", ""), // Los Angeles or Louisiana?
        zrow(10, "Wash.", "09001"), // military again
        zrow(11, "Washington", "98101"), // a Seattle zip CONFIRMS
        zrow(12, "L.A.", "70112"), // a New Orleans zip confirms Louisiana
        zrow(13, "Washington 98101", ""), // a confirming zip inside the text
      ]),
    ]);
    const rows = reportsOfPipeline(o);
    expect(rows.map((r) => r.verdict)).toEqual([
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "UNRESOLVED:AMBIGUOUS_NEEDS_ZIP",
      "RESOLVED_LOCAL_EXACT",
      "RESOLVED_LOCAL_ALIAS",
      "RESOLVED_LOCAL_ALIAS",
    ]);
    expect(rows.slice(0, 10).every((r) => r.stateCode === null)).toBe(true);
    expect(rows[10].stateCode).toBe("WA");
    expect(rows[11].stateCode).toBe("LA");
    expect(rows[12].stateCode).toBe("WA");
    // the write list only FLAGS an unresolved row — an AMBIGUOUS_NEEDS_ZIP never receives a code
    const actions = (o.value.updates as { action: string; stateCode: unknown }[]).map(
      (u) => `${u.action}:${u.stateCode}`,
    );
    expect(actions.slice(0, 10)).toEqual(Array(10).fill("flag-review:null"));
  });

  it("X9: an unambiguous text and a bare 2-letter code are unaffected — Idaho and LA resolve without a zip", () => {
    const [o] = evaluate([
      plan([
        zrow(1, "Idaho", ""), // a state name that is not in the ambiguous set
        zrow(2, "LA", ""), // the bare code is Louisiana; only the punctuated "L.A." is ambiguous
        zrow(3, "la", ""),
        zrow(4, "Tex", "09001"), // an unambiguous alias, military zip: no check, no block
        zrow(5, "OR", ""), // a bare code that is also an English word
      ]),
    ]);
    const rows = reportsOfPipeline(o);
    expect(rows.map((r) => r.stateCode)).toEqual(["ID", "LA", "LA", "TX", "OR"]);
    expect(rows.every((r) => r.reason === null)).toBe(true);
  });

  it("X10: the ambiguous set is pinned exactly — a name is added or removed on purpose", () => {
    const o = evaluate([get("AMBIGUOUS_STATE_TEXTS")]);
    expect((o[0].value as string[]).sort()).toEqual(
      [
        "california",
        "delaware",
        "florida",
        "georgia",
        "indiana",
        "kansas",
        "la",
        "louisiana",
        "nevada",
        "oregon",
        "virginia",
        "wash",
        "washington",
        "wyoming",
      ].sort(),
    );
  });

  // Every member of the set, behaviourally (X10 pins the list; this pins what each one DOES): a
  // blank zip and a military zip leave it unresolved, a zip inside its own state confirms it.
  it.each([
    ["Washington", "98101", "WA"],
    ["Wash.", "98101", "WA"],
    ["Kansas", "66101", "KS"],
    ["Indiana", "46201", "IN"],
    ["Delaware", "19901", "DE"],
    ["Oregon", "97201", "OR"],
    ["Nevada", "89101", "NV"],
    ["Wyoming", "82001", "WY"],
    ["Virginia", "22201", "VA"],
    ["California", "90012", "CA"],
    ["Louisiana", "70112", "LA"],
    ["Florida", "33101", "FL"],
    ["Georgia", "30301", "GA"],
    ["L.A.", "70112", "LA"],
    ["La.", "70112", "LA"], // the AP abbreviation for Louisiana folds to the same key as "L.A."
  ])(
    "X12: %s — blank / military zip → AMBIGUOUS_NEEDS_ZIP, a confirming zip (%s) → %s",
    (text, zip, code) => {
      const [o] = evaluate([plan([zrow(1, text, ""), zrow(2, text, "09001"), zrow(3, text, zip)])]);
      const rows = reportsOfPipeline(o);
      expect(rows.map((r) => r.verdict.startsWith("RESOLVED"))).toEqual([false, false, true]);
      expect(rows.slice(0, 2).map((r) => r.reason)).toEqual([
        "AMBIGUOUS_NEEDS_ZIP",
        "AMBIGUOUS_NEEDS_ZIP",
      ]);
      expect(rows[2].stateCode).toBe(code);
    },
  );

  it("X13: a bare 2-letter code is never ambiguous, even the ones that are English words or city initials", () => {
    const [o] = evaluate([
      plan(
        ["LA", "la", "La", "OR", "IN", "ME", "OK", "OH", "DE"].map((t, i) => zrow(i + 1, t, "")),
      ),
    ]);
    const rows = reportsOfPipeline(o);
    expect(rows.map((r) => r.stateCode)).toEqual([
      "LA",
      "LA",
      "LA",
      "OR",
      "IN",
      "ME",
      "OK",
      "OH",
      "DE",
    ]);
    expect(rows.every((r) => r.reason === null)).toBe(true);
  });

  it("X11: an ambiguous row that needs a zip is NEVER sent to Google (it is a local AMBIGUOUS_NEEDS_ZIP, not an UNPARSEABLE)", () => {
    const [o] = evaluate([
      plan([zrow(1, "Washington", "", { googleSendable: true })], gcfg([{ forbidden: true }])),
    ]);
    expect(o.ok).toBe(true);
    expect(reportsOfPipeline(o)[0].verdict).toBe("UNRESOLVED:AMBIGUOUS_NEEDS_ZIP");
    expect(o.calls).toHaveLength(0); // the fake fetch (which throws if reached) was never called
  });
});

const reportsOfPipeline = (o: Outcome) =>
  JSON.parse(o.value.json).rows as Array<Report & { conflictCode?: string; zipStates?: string[] }>;

// ─── S: strict Google acceptance (review round 2, BLOCKER 2) ──────────────────────────────────

describe("normalize-address-states — strict Google acceptance (an INFERRED state is never written)", () => {
  const one = (script: unknown[], over: Row = {}) => batch([row(1, over)], gcfg(script));

  it("S1: the accepting fixture — complete, US, CONFIRMED admin area, un-inferred locality and postal code", () => {
    const [o] = evaluate([
      one([
        withComponents([
          component("street_number", "9999"),
          component("locality", "Faketown"),
          component("administrative_area_level_1", "TX", {
            spellCorrected: false,
            inferred: false,
          }),
          component("postal_code", "09909"),
        ]),
      ]),
    ]);
    expect(reportsOf(o)[0]).toMatchObject({ verdict: "RESOLVED_GOOGLE", stateCode: "TX" });
    expect(o.value.google).toMatchObject({ resolved: 1 });
  });

  it("S2: every component-level rejection is UNRESOLVED:GOOGLE_INFERRED — never a state", () => {
    const admin = (over: Row = {}) => component("administrative_area_level_1", "TX", over);
    const locality = (over: Row = {}) => component("locality", "Faketown", over);
    const postal = (over: Row = {}) => component("postal_code", "09909", over);
    const cases: Array<[string, ReturnType<typeof withComponents>]> = [
      ["components absent (cannot verify)", withComponents(undefined)],
      ["components null", withComponents(null)],
      ["components an object, not an array", withComponents({ 0: admin() })],
      ["components a string", withComponents("administrative_area_level_1")],
      ["components empty", withComponents([])],
      ["no admin-area component", withComponents([locality(), postal()])],
      [
        "admin area UNCONFIRMED_BUT_PLAUSIBLE",
        withComponents([admin({ confirmationLevel: "UNCONFIRMED_BUT_PLAUSIBLE" })]),
      ],
      [
        "admin area UNCONFIRMED_AND_SUSPICIOUS",
        withComponents([admin({ confirmationLevel: "UNCONFIRMED_AND_SUSPICIOUS" })]),
      ],
      [
        "admin area confirmationLevel absent",
        withComponents([admin({ confirmationLevel: undefined })]),
      ],
      ["admin area inferred", withComponents([admin({ inferred: true })])],
      ["admin area replaced", withComponents([admin({ replaced: true })])],
      ["admin area spellCorrected", withComponents([admin({ spellCorrected: true })])],
      ["locality inferred", withComponents([locality({ inferred: true }), admin(), postal()])],
      ["locality replaced", withComponents([locality({ replaced: true }), admin(), postal()])],
      ["postal_code inferred", withComponents([locality(), admin(), postal({ inferred: true })])],
      ["postal_code replaced", withComponents([locality(), admin(), postal({ replaced: true })])],
      [
        "verdict.hasReplacedComponents",
        withComponents([locality(), admin(), postal()], { hasReplacedComponents: true }),
      ],
      [
        "verdict.hasInferredComponents",
        withComponents([locality(), admin(), postal()], { hasInferredComponents: true }),
      ],
      ["two admin-area components", withComponents([admin(), admin(), locality(), postal()])],
      [
        "the CONFIRMED admin area names a DIFFERENT state than postalAddress",
        withComponents([locality(), component("administrative_area_level_1", "CA"), postal()]),
      ],
      [
        "the admin-area component carries no name at all",
        withComponents([locality(), admin({ componentName: undefined }), postal()]),
      ],
      [
        "the admin-area component name is not a state",
        withComponents([
          locality(),
          component("administrative_area_level_1", "Faketown"),
          postal(),
        ]),
      ],
    ];
    const o = evaluate(cases.map(([, response]) => one([response])));
    cases.forEach(([label], i) => {
      const [r] = reportsOf(o[i]);
      expect([label, r.verdict, r.stateCode, r.reason]).toEqual([
        label,
        "UNRESOLVED:GOOGLE_INFERRED",
        null,
        "GOOGLE_INFERRED",
      ]);
      expect(o[i].value.google).toMatchObject({ attempted: 1, resolved: 0 });
    });
  });

  it("S3: the older checks still win first — incomplete, non-US and non-state answers keep their reasons", () => {
    const inferred = [component("administrative_area_level_1", "TX", { inferred: true })];
    const o = evaluate([
      // incomplete beats inferred components
      one([
        {
          status: 200,
          body: {
            result: {
              verdict: { addressComplete: false },
              address: {
                postalAddress: { regionCode: "US", administrativeArea: "TX" },
                addressComponents: inferred,
              },
            },
          },
        },
      ]),
      one([complete("WA", {}, "AU")]),
      one([complete("Tejas")]),
    ]);
    expect(reportsOf(o[0])[0].reason).toBe("GOOGLE_INCOMPLETE");
    expect(reportsOf(o[1])[0].reason).toBe("GOOGLE_NO_MATCH");
    expect(reportsOf(o[2])[0].reason).toBe("GOOGLE_NO_MATCH");
  });

  it("S4: a blank / unusable zip is NEEDS_ZIP — listed, and NEVER sent, in either mode", () => {
    const blanks = ["", "   ", "1234", "123456", "abcde", "77O01", "77001-12"];
    const rows = blanks.map((zip, i) => row(i + 1, { zip }));
    const [withGoogle, without] = evaluate([
      batch(rows, gcfg([complete("TX")])),
      batch(rows, null),
    ]);
    for (const x of [withGoogle, without]) {
      expect(reportsOf(x).map((r) => r.verdict)).toEqual(
        Array(blanks.length).fill("UNRESOLVED:NEEDS_ZIP"),
      );
    }
    expect(withGoogle.calls).toHaveLength(0);
    expect(withGoogle.value.google).toMatchObject({ needed: 0, attempted: 0 });
    // a ZIP+4 IS usable, and only then does a request go out
    const [plus4] = evaluate([batch([row(1, { zip: "77001-1234" })], gcfg([complete("TX")]))]);
    expect(plus4.calls).toHaveLength(1);
    expect(reportsOf(plus4)[0].verdict).toBe("RESOLVED_GOOGLE");
  });

  it("S5: NEEDS_ZIP only replaces UNPARSEABLE — EMPTY and a locally resolved state are untouched", () => {
    const [o] = evaluate([
      batch(
        [
          row(1, { state: "", zip: "" }),
          row(2, { state: "Texas", zip: "" }),
          row(3, { state: "Tejas", zip: "", googleSendable: false }),
        ],
        null,
      ),
    ]);
    expect(reportsOf(o).map((r) => r.verdict)).toEqual([
      "UNRESOLVED:EMPTY",
      "RESOLVED_LOCAL_EXACT",
      "UNRESOLVED:NEEDS_ZIP",
    ]);
  });

  it("S6: the listing SQL makes a usable zip part of googleSendable and exposes only a 3-digit prefix", () => {
    const o = evaluate([
      call("candidateSql"),
      call("candidateSql", { withAddress: true, tenantScoped: true }),
    ]);
    for (const x of o) {
      const sql = x.value as string;
      expect(sql).toMatch(/btrim\(a\."line1"\) <> '' AND btrim\(a\."zip"\) ~ /);
      expect(sql).toContain('AS "googleSendable"');
      expect(sql).toContain('left(btrim(a."zip"), 3)');
      expect(sql).toContain('AS "zip3"');
    }
    // the report path still never loads the full zip / line1 / city as a column
    const plain = o[0].value as string;
    expect(plain).not.toContain('AS "zip"');
    expect(plain).not.toContain('AS "line1"');
    expect(plain).not.toContain('AS "city"');
  });
});

// ─── P: gate before ANY Google call, ceiling, confirmation (review round 2) ───────────────────

describe("normalize-address-states — planRun: the gate, the ceiling and Google, in that order", () => {
  const LIVE_TENANT = "33333333-3333-4333-8333-333333333333";
  const LIVE_SLUG = "acme-widgets"; // client-shaped, NOT an approved test tenant
  // A response script whose ONLY step throws: if the batch ever reaches fetch the case is loud.
  const NEVER = [{ forbidden: true }];
  const plan = (rows: Row[], over: Row = {}, google: unknown = gcfg(NEVER)) => ({
    kind: "plan",
    rows,
    google,
    ...over,
  });
  const live = (n: number, over: Row = {}) =>
    row(n, { tenantId: LIVE_TENANT, tenantSlug: LIVE_SLUG, ...over });

  it("P1 (BLOCKER 1): --google + --only-test-tenants on a live-looking tenant is refused and fetch is NEVER called", () => {
    const [o] = evaluate([
      plan([live(1, { state: "Tejas" }), live(2, { state: "Nowhere" })], {
        onlyTestTenants: true,
      }),
    ]);
    expect(o.ok).toBe(false);
    expect(o.name).toBe("TestTenantListingRefusedError");
    expect(o.calls).toHaveLength(0); // zero requests: the fake fetch throws if it is ever reached
    // the refusal names TENANT ids + slugs and nothing else — no address row, no state text
    expect(o.message).toContain("--only-test-tenants refuses this run");
    expect(o.message).toContain(`tenantId=${LIVE_TENANT}`);
    expect(o.message).toContain(`tenantSlug=${LIVE_SLUG}`);
    expect(o.message).toContain("(2 candidate row(s))");
    expect(o.message).toContain("NOTHING was sent to Google");
    expect(o.message).not.toContain(id(1));
    expect(o.message).not.toContain(id(2));
    expect(o.message).not.toContain("Tejas");
    expect(o.message).not.toContain("Nowhere");
    expect(o.message).not.toContain(FIXTURE.line1);
  });

  it("P2: ONE non-approved tenant refuses the WHOLE batch, however many approved rows sit beside it", () => {
    const [o] = evaluate([
      plan(
        [
          row(1),
          row(2),
          live(3, { state: "Tejas" }),
          row(4),
          row(5, { tenantId: TENANT_B, tenantSlug: "test" }),
        ],
        { onlyTestTenants: true },
      ),
    ]);
    expect(o.name).toBe("TestTenantListingRefusedError");
    expect(o.calls).toHaveLength(0);
    expect(o.message).toContain("1 of 3 tenant(s)");
    expect(o.message).toContain(`tenantSlug=${LIVE_SLUG}`);
    expect(o.message).not.toContain("tenantSlug=qa-nas");
  });

  it("P3: an unresolvable tenant (an id with no slug) refuses; a NULL-tenant row cannot trip the gate", () => {
    const [noSlug, nullTenant] = evaluate([
      plan([row(1, { tenantSlug: null })], { onlyTestTenants: true }),
      plan([row(1, { tenantId: null, tenantSlug: null })], { onlyTestTenants: true }, null),
    ]);
    expect(noSlug.name).toBe("TestTenantListingRefusedError");
    expect(noSlug.message).toContain("tenantSlug=<unresolvable>");
    expect(noSlug.calls).toHaveLength(0);
    expect(nullTenant.ok).toBe(true);
    expect(reportsOf(nullTenant)[0].verdict).toBe("UNRESOLVED:NULL_TENANT");
  });

  it("P4 (control): an APPROVED tenant passes the gate and DOES reach Google — so P1's zero is the gate's doing", () => {
    const [o] = evaluate([
      plan([row(1)], { onlyTestTenants: true }, gcfg([complete("TX")])),
      // and the gate is opt-in: without the flag a client tenant is classified (and sent) as before
      plan([live(1)], { onlyTestTenants: false }, gcfg([complete("TX")])),
    ]);
    expect(o.ok).toBe(true);
    expect(o.calls).toHaveLength(1);
    const [, ungated] = evaluate([
      plan([row(1)], { onlyTestTenants: true }, gcfg([complete("TX")])),
      plan([live(1)], { onlyTestTenants: false }, gcfg([complete("TX")])),
    ]);
    expect(ungated.ok).toBe(true);
    expect(ungated.calls).toHaveLength(1);
  });

  it("P5 (MAJOR 5): more candidates than --max-rows is refused before any request, naming the count and the flag", () => {
    const rows = Array.from({ length: 4 }, (_, i) => row(i + 1));
    const [over, atMax, defaults] = evaluate([
      plan(rows, { maxRows: 3 }),
      plan(rows, { maxRows: 4 }, gcfg([complete("TX")])),
      plan(
        Array.from({ length: 501 }, (_, i) => row(i + 1, { state: "Texas" })),
        {},
        null,
      ),
    ]);
    expect(over.ok).toBe(false);
    expect(over.name).toBe("MaxRowsExceededError");
    expect(over.calls).toHaveLength(0);
    expect(over.message).toContain("4 candidate row(s)");
    expect(over.message).toContain("--max-rows is 3");
    expect(over.message).toContain("--max-rows 4");
    expect(over.message).toContain("nothing was written");
    // exactly at the ceiling is fine — the check is `>`, not `>=`
    expect(atMax.ok).toBe(true);
    expect(atMax.calls).toHaveLength(4);
    // the default ceiling is 500: 501 candidates refuse even with no explicit flag
    expect(defaults.ok).toBe(false);
    expect(defaults.message).toContain("501 candidate row(s)");
    expect(defaults.message).toContain("--max-rows is 500");
    const [ok500] = evaluate([
      plan(
        Array.from({ length: 500 }, (_, i) => row(i + 1, { state: "Texas" })),
        {},
        null,
      ),
    ]);
    expect(ok500.ok).toBe(true);
    expect(reportsOf(ok500)).toHaveLength(500);
  });

  it("P6: when a run breaks BOTH the tenant gate and the ceiling, the tenant gate is what refuses", () => {
    const [o] = evaluate([
      plan([live(1), live(2), live(3)], { onlyTestTenants: true, maxRows: 1 }),
    ]);
    expect(o.name).toBe("TestTenantListingRefusedError");
    expect(o.calls).toHaveLength(0);
  });

  it("P7: assertTestTenantListing and assertMaxRows are usable on their own", () => {
    const o = evaluate([
      call("assertTestTenantListing", [
        { tenantId: "a", tenantSlug: "test" },
        { tenantId: "b", tenantSlug: "qa-x" },
        { tenantId: null, tenantSlug: null },
      ]),
      call("assertTestTenantListing", []),
      call("assertTestTenantListing", [{ tenantId: "c", tenantSlug: "testing-co" }]),
      call("assertMaxRows", 500),
      call("assertMaxRows", 501),
      call("assertMaxRows", 2, 2),
      call("assertMaxRows", 3, 2),
    ]);
    expect(o[0].value).toEqual({ tenants: 2, rows: 2 });
    expect(o[1].value).toEqual({ tenants: 0, rows: 0 });
    expect(o[2].ok).toBe(false); // near-miss slugs are client tenants
    expect(o.map((x) => x.ok)).toEqual([true, true, false, true, false, true, false]);
  });
});

describe("normalize-address-states — the live confirmation: --expect-rows and the typed phrase", () => {
  it("E1: --expect-rows is checked against THIS run's computed write count", () => {
    const o = evaluate([
      call("checkExpectRows", null, 6),
      call("checkExpectRows", undefined, 6),
      call("checkExpectRows", 6, 6),
      call("checkExpectRows", 0, 0),
      call("checkExpectRows", 5, 6),
      call("checkExpectRows", 7, 6),
      call("checkExpectRows", 0, 3),
    ]);
    expect(o.map((x) => x.value ?? null)).toEqual([
      null,
      null,
      null,
      null,
      expect.stringContaining("--expect-rows 5 does not match the 6 row(s)"),
      expect.stringContaining("--expect-rows 7 does not match the 6 row(s)"),
      expect.stringContaining("--expect-rows 0 does not match the 3 row(s)"),
    ]);
    expect(o[4].value).toContain("Nothing was written");
  });

  it("E2: the phrase is NORMALIZE <n> ADDRESSES and only the exact phrase (trimmed) confirms", () => {
    const phrase = "NORMALIZE 6 ADDRESSES";
    const o = evaluate([
      call("confirmationPhrase", 6),
      call("confirmationPhrase", 0),
      call("confirmationMatches", phrase, phrase),
      call("confirmationMatches", `  ${phrase}\n`, phrase),
      call("confirmationMatches", "normalize 6 addresses", phrase),
      call("confirmationMatches", "NORMALIZE 5 ADDRESSES", phrase),
      call("confirmationMatches", "NORMALIZE 6 ADDRESSES please", phrase),
      call("confirmationMatches", "", phrase),
      call("confirmationMatches", null, phrase),
      call("confirmationMatches", 6, phrase),
    ]);
    expect(o.map((x) => x.value)).toEqual([
      "NORMALIZE 6 ADDRESSES",
      "NORMALIZE 0 ADDRESSES",
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

// ─── W: the write transaction, against a recording fake of a pg client ────────────────────────

describe("normalize-address-states — applyUpdates (the live write path, behaviourally, no database)", () => {
  // NOTE: the DB lane (`normalize-address-states.db.spec.ts`) is the REAL proof of this path against
  // Postgres. These cases pin the sequencing and the rollback contract with no database at all.
  const upd = (n: number, action: "set-state" | "flag-review") =>
    action === "set-state"
      ? {
          table: "CustomerAddress",
          id: id(n),
          tenantId: TENANT_A,
          action,
          stateCode: "TX",
          sql: SET_SQL,
          params: ["TX", id(n), TENANT_A],
        }
      : {
          table: "CustomerAddress",
          id: id(n),
          tenantId: TENANT_A,
          action,
          stateCode: null,
          sql: FLAG_SQL,
          params: [id(n), TENANT_A],
        };
  const apply = (updates: unknown[], extra: Row = {}) => ({
    kind: "apply",
    updates,
    results: [],
    ...extra,
  });
  const sqls = (o: Outcome) => (o.value.queries as { sql: string }[]).map((q) => q.sql);

  it("W1: lifts read-only, opens ONE transaction, runs each guarded statement in report order, then COMMITs", () => {
    const updates = [upd(1, "set-state"), upd(2, "flag-review"), upd(3, "set-state")];
    const [o] = evaluate([apply(updates)]);
    expect(o.ok).toBe(true);
    expect(o.value.result).toEqual({ code: 0, applied: { "set-state": 2, "flag-review": 1 } });
    expect(sqls(o)).toEqual([
      "SET default_transaction_read_only = off",
      "BEGIN",
      SET_SQL,
      FLAG_SQL,
      SET_SQL,
      "COMMIT",
    ]);
    // each statement ran with ITS OWN bound values (id-pinned), in order
    const bound = (o.value.queries as { params: unknown[] | null }[]).map((q) => q.params);
    expect(bound.slice(2, 5)).toEqual([
      ["TX", id(1), TENANT_A],
      [id(2), TENANT_A],
      ["TX", id(3), TENANT_A],
    ]);
  });

  it("W2: a statement that touches no row (changed under us) is exit 4 — ROLLBACK, no COMMIT, nothing after it runs", () => {
    const updates = [upd(1, "set-state"), upd(2, "flag-review"), upd(3, "set-state")];
    const [zero, two] = evaluate([
      apply(updates, { results: [1, 0, 1] }),
      apply(updates, { results: [1, 2, 1] }), // more than one row is just as wrong
    ]);
    for (const o of [zero, two]) {
      expect(o.ok).toBe(true);
      expect(o.value.result).toEqual({
        code: 4,
        applied: {},
        changed: { table: "CustomerAddress", id: id(2) },
      });
      expect(sqls(o)).toEqual([
        "SET default_transaction_read_only = off",
        "BEGIN",
        SET_SQL, // ran inside the same transaction as the failure...
        FLAG_SQL,
        "ROLLBACK", // ...so the WHOLE batch is undone
      ]);
      expect(sqls(o)).not.toContain("COMMIT");
    }
  });

  it("W3: a query error rolls back and rethrows — never a COMMIT", () => {
    const updates = [upd(1, "set-state"), upd(2, "flag-review")];
    const [o] = evaluate([apply(updates, { throwAt: 3 })]); // 0 SET, 1 BEGIN, 2 first UPDATE, 3 second
    expect(o.ok).toBe(false);
    expect(o.message).toBe("boom");
    expect(sqls(o)).toEqual([
      "SET default_transaction_read_only = off",
      "BEGIN",
      SET_SQL,
      FLAG_SQL,
      "ROLLBACK",
    ]);
  });

  it("W4: nothing is written before the read-only flag is lifted, and no statement outside the write list runs", () => {
    const [o] = evaluate([apply([upd(1, "flag-review")])]);
    const all = sqls(o);
    expect(all[0]).toBe("SET default_transaction_read_only = off");
    expect(all.indexOf("BEGIN")).toBe(1);
    const writes = all.filter((s) => /^UPDATE /.test(s));
    expect(writes).toEqual([FLAG_SQL]);
    expect(
      all.every((s) => s === "BEGIN" || s === "COMMIT" || s.startsWith("SET ") || s === FLAG_SQL),
    ).toBe(true);
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

const LIB = path.resolve(API_DIR, "scripts/lib/address-state-normalize.mjs");

/** The CLI's non-comment lines — a claim in a comment must never satisfy a source pin. */
function cliCodeLines(): string {
  return codeLinesOf(CLI);
}

function libCodeLines(): string {
  return codeLinesOf(LIB);
}

function codeLinesOf(file: string): string {
  return fs
    .readFileSync(file, "utf8")
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
      "NEEDS_ZIP",
      "AMBIGUOUS_NEEDS_ZIP",
      "GOOGLE_INFERRED",
      "ZIP_CONFLICT",
      "NULL_TENANT",
      "NEVER guessed",
      "--max-rows",
      "--expect-rows",
      "--show-unresolved-text",
      "one tenant at a time",
      "REQUIRES --tenant-slug",
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
    // review round 2: the owner command block carries the per-tenant Google usage and the new flags
    expect(header).toContain("--expect-rows <n>");
    expect(header).toContain("--max-rows");
    expect(header).toContain("ONE TENANT AT A TIME");
    expect(header).toContain("--tenant-slug <client-slug>");
    expect(header).toContain("--dry-run --google --google-max 200");
    expect(header).toContain("--show-unresolved-text");
  });

  it("C16 (BLOCKER 1b): --google REQUIRES --tenant-slug — refused before any connection, key or no key", () => {
    const withKey = refused(runCli(["--google"], { GOOGLE_MAPS_API_KEY: KEY }));
    expect(withKey).toContain("--google requires --tenant-slug");
    expect(withKey).not.toContain(KEY);
    for (const args of [
      ["--google", "--dry-run"],
      ["--google", "--only-test-tenants"],
      ["--google", "--google-max", "5"],
    ]) {
      expect(refused(runCli(args, { GOOGLE_MAPS_API_KEY: KEY }))).toContain("--tenant-slug");
    }
  });

  it("C17 (MAJOR 5): --max-rows must be a positive whole number", () => {
    for (const bad of ["0", "abc", "-1", "1.5", "", "1e3", " 5", "05"]) {
      expect(refused(runCli(["--max-rows", bad]))).toContain(
        "--max-rows must be a positive whole number",
      );
    }
    expect(refused(runCli(["--max-rows=0", "--dry-run"]))).toContain("--max-rows");
  });

  it("C18: --expect-rows is --live only, a whole number, and REQUIRED unless --only-test-tenants --confirm supplies the count", () => {
    // meaningless outside --live
    expect(refused(runCli(["--expect-rows", "3"]))).toContain(
      "--expect-rows is only meaningful with --live",
    );
    expect(refused(runCli(["--dry-run", "--expect-rows", "3"]))).toContain(
      "only meaningful with --live",
    );
    // not a count
    for (const bad of ["abc", "-1", "1.5", "", "007"]) {
      const combined = refused(runCli(["--live", "--backup-attested", "b", "--expect-rows", bad]));
      expect(combined).toContain("--expect-rows must be a whole number");
    }
    // interactive / token --live without it: refused before connecting
    for (const args of [
      ["--live", "--backup-attested", "backup 2026-09-19"],
      ["--live", "--backup-attested", "backup", "--only-test-tenants"], // no --confirm: still the prompt path
    ]) {
      expect(refused(runCli(args))).toContain("--live requires --expect-rows");
    }
    expect(
      refused(
        runCli(["--live", "--backup-attested", "b"], {
          NORMALIZE_CONFIRM_TOKEN: "NORMALIZE 1 ADDRESSES",
        }),
      ),
    ).toContain("--live requires --expect-rows");
  });

  it("C12: the session is read-only in code; the only writes are the lib's guarded statements", () => {
    // Source greps, kept as a tripwire only. The BEHAVIOUR of the write path is proven by the
    // applyUpdates cases (W1-W4, a recording fake client) and — the real proof — by the DB lane
    // (`normalize-address-states.db.spec.ts`, D5-D9) against a real Postgres.
    const code = cliCodeLines();
    const lib = libCodeLines();

    expect(code).toContain("default_transaction_read_only = on");
    // lifted only by the lib's write path, which the CLI calls after the typed confirmation
    expect(code).not.toContain("default_transaction_read_only = off");
    expect(lib).toContain("default_transaction_read_only = off");
    expect(code).toContain("await applyUpdates(client, updates)");
    // only the pure module may build a write statement
    expect(code).not.toMatch(/UPDATE\s+"/);
    expect(code).not.toMatch(/\b(INSERT|DELETE)\s+(INTO|FROM)\b/i);
    // one transaction, checked row by row, rolled back (exit 4) when a row changed under us
    expect(lib).toContain('await client.query("BEGIN")');
    expect(lib).toContain("res.rows.length !== 1");
    expect(lib).toContain('await client.query("ROLLBACK")');
    expect(lib).toContain("code: 4");
    expect(code).toContain("code: 4");
  });

  it("C13: NORMALIZE_CONFIRM_TOKEN is gated on JEST_WORKER_ID and never relaxes the attestation", () => {
    const code = cliCodeLines();

    expect(code).toContain("process.env.JEST_WORKER_ID");
    expect(code).toContain("WARNING: test override NORMALIZE_CONFIRM_TOKEN active");
    expect(code).toContain("is ignored outside test");
    // the owner's --confirm wins over the test hook, and the phrase is still compared (the
    // comparison itself is `confirmationMatches`, behaviourally covered by E2)
    expect(code).toContain("opts.confirm !== null ? opts.confirm : confirmTokenOverride()");
    expect(code).toContain("!confirmationMatches(answer, phrase)");
    // --live still refuses without an attested backup, token or no token
    expect(runCli(["--live"], { NORMALIZE_CONFIRM_TOKEN: "NORMALIZE 1 ADDRESSES" }).status).toBe(2);
  });

  it("C14: the guard resolves against the WRITE LIST, and the Google cap maps to exit 2", () => {
    const code = cliCodeLines();

    expect(code).toContain("assertTestTenantTargets(updates, slugById)");
    // BLOCKER 1's fix lives in the ORDER planRun enforces (tenant gate on the listing, then the row
    // ceiling, then classification/Google). The CLI must go through it: calling classifyBatch
    // directly would put every Google request back BEFORE the gate, and the pure-lib P-cases (which
    // drive planRun themselves) would stay green.
    expect(code).toContain("await planRun(listing.rows, {");
    expect(code).not.toContain("classifyBatch(");
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
