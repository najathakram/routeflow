#!/usr/bin/env node
// FG-1 WP1 (R10, R11) — fetch the entitlement sweep from an API, check one sweep, compare two.
//
//   fetch:    ENTITLEMENT_SWEEP_API_URL=http://localhost:3000/api/v1 \
//             ENTITLEMENT_SWEEP_TOKEN=<super-admin access token> \
//             node scripts/entitlement-sweep.mjs [--out local-assets/entitlement-sweep-a.json] [--limit 50]
//   check:    node scripts/entitlement-sweep.mjs --check a.json
//   compare:  node scripts/entitlement-sweep.mjs --compare a.json b.json [--new-keys k1,k2]
//
// NEVER RUNS AGAINST PRODUCTION BY ITSELF. The fetch refuses (exit 3) any base URL whose host is not
// localhost / 127.0.0.1 / ::1, before any request is made, unless the owner passes
// `--i-am-the-owner-running-this-per-command` on that very command line. No production URL is
// written in this file; the token and the URL come from the environment names above only.
//
// Output: one JSON file under `local-assets/` (gitignored; created if missing): the first page's
// { mode, planFlagEnforcement } plus every tenant row. Tenant ids are the API's one-way hashes,
// never a raw id, slug or name. This script only reads JSON; it imports nothing from the API.
//
// SA-1100 §3 — two comparisons:
//
// --check <file> (inside ONE sweep): each (tenant, key) and each set row gets one class.
//   agree         old == effective
//   courtesy gap  old true, effective false, and the row's `courtesy` bit is true. Expected before
//                 WP2; counted per key. Under `--after-wp2` (S2, the sweep after WP2 deploys) it fails.
//                 `--after-wp2` also adds one class: a row served without `strict` and without the
//                 `courtesy` bit (effective true, strict false, courtesy false) is unexplained.
//   unexplained   anything else (a tenant the resolver could not resolve counts here). Exit 2: the
//                 stage stops and comes back to the architect.
//   client drift  clientFlag != strict on a flag key, or clientAddon != strict on an add-on key (M-8: the
//                 answer clients are meant to show, so a courtesy key the client hides is "agree, hidden
//                 by design"; a file with no strict bit compares with old). Listed
//                 per key as WP8's input; it never fails the check.
//   Prints mode + planFlagEnforcement. A "live" mode or planFlagEnforcement "on" prints a WP2-STOP
//   line and exits 4: WP2 must not merge. A file that cannot be trusted at all (no tenants, mode or
//   planFlagEnforcement missing, or the API reported modeReadFailed) is refused with exit 3.
//
// --compare a.json b.json (BETWEEN two sweeps): "no change" means all of
//   - mode and planFlagEnforcement are equal, else REFUSED (exit 3, "not comparable"): a switch flip
//     changes answers while the inputs stay the same;
//   - the key set is equal, else exit 2. A build that really adds a gated key names it with
//     --new-keys k1,k2 (a set row is named "set:<keys joined by |>"); a key present in only the
//     first file is never excused;
//   - for each tenant whose inputsHash is unchanged, old / effective / strict / clientAddon /
//     clientFlag are identical, else exit 2, except under `--expect wp2` (S1 -> S2): `effective` may go
//     false -> true only where B's row has `courtesy` true and `old` is unchanged, and B's `strict`
//     must equal A's `effective`. Any other value after `--expect` is refused (exit 3).
//   inputsHash covers each override's live bit at sweep time, so a lapse is a changed input.
//
// Exit codes: 0 fine; 2 an unexplained difference (check) / a difference with unchanged inputs, a
// key-set change or a tenant whose resolve_failed state differs (compare); 3 refused (bad URL,
// missing env, path outside local-assets, an unusable or not-comparable file, a WP2-only flag);
// 4 --check only: WP2-STOP (mode live or planFlagEnforcement on); 1 any other failure.
// --check precedence when several apply: 3, then 4, then 2 (every line is still printed). Only exit 0
// is "go"; S1 and S2 read anything else as a stop.
// Reports print only hashed tenant ids and key names.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_FLAG = "--i-am-the-owner-running-this-per-command";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BITS = ["old", "effective", "strict", "clientAddon", "clientFlag"];

const refuse = (message) => {
  console.error(`entitlement-sweep: ${message}`);
  process.exit(3);
};

const rowsOf = (t) => ({
  ...(t.keys ?? {}),
  ...Object.fromEntries(Object.entries(t.sets ?? {}).map(([k, v]) => [`set:${k}`, v])),
});

/** Every gated key (and `set:` row) name present in any tenant of a sweep file. */
export function keySet(file) {
  const names = new Set();
  for (const t of file.tenants ?? []) for (const k of Object.keys(rowsOf(t))) names.add(k);
  return names;
}

/**
 * Pure: `{ differences: [{ tenant, key, bit, a, b }], onlyInA, onlyInB, inputsChanged, keysOnlyInA,
 * keysOnlyInB, newKeys }`. `newKeys` (SA-1100 §3) are key names the second file may add: they are
 * left out of both the key-set check and the per-tenant bit comparison.
 */
export function compareSweeps(a, b, { newKeys = [], expect = null } = {}) {
  const byId = (file) => new Map((file.tenants ?? []).map((t) => [t.id, t]));
  const ma = byId(a);
  const mb = byId(b);
  const excused = new Set(newKeys);
  const differences = [];
  let inputsChanged = 0;
  for (const [id, ta] of ma) {
    const tb = mb.get(id);
    if (!tb) continue;
    // A tenant that resolved in one sweep and not in the other is a difference whatever its hash says
    // (a resolve_failed row hashes without plan or version, so it always reads as "inputs changed").
    if ((ta.error ?? null) !== (tb.error ?? null)) {
      differences.push({
        tenant: id,
        key: "(resolve_failed)",
        bit: "error",
        a: ta.error ?? "resolved",
        b: tb.error ?? "resolved",
      });
      continue;
    }
    if (ta.inputsHash !== tb.inputsHash) {
      inputsChanged += 1;
      continue;
    }
    const ra = rowsOf(ta);
    const rb = rowsOf(tb);
    for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      if (excused.has(key) && !(key in ra)) continue;
      for (const bit of BITS) {
        const va = ra[key]?.[bit];
        const vb = rb[key]?.[bit];
        if (expect === "wp2" && (bit === "effective" || bit === "strict")) {
          const row = rb[key];
          if (bit === "effective") {
            // served may only be ADDED, and only by the courtesy, with the served-by-guards answer unchanged
            if (va === vb) continue;
            if (va === false && vb === true && row?.courtesy === true && ra[key]?.old === row?.old)
              continue;
            differences.push({ tenant: id, key, bit, a: va, b: vb });
          } else if (vb !== ra[key]?.effective) {
            // S2 strict is the owner's rule: it must be what S1 served (S1 had no courtesy in it)
            differences.push({ tenant: id, key, bit, a: ra[key]?.effective, b: vb });
          }
          continue;
        }
        if (va !== vb) differences.push({ tenant: id, key, bit, a: va, b: vb });
      }
    }
  }
  const onlyInA = [...ma.keys()].filter((id) => !mb.has(id)).length;
  const onlyInB = [...mb.keys()].filter((id) => !ma.has(id)).length;
  const ka = keySet(a);
  const kb = keySet(b);
  const keysOnlyInA = [...ka].filter((k) => !kb.has(k)).sort();
  const keysOnlyInB = [...kb].filter((k) => !ka.has(k) && !excused.has(k)).sort();
  return {
    differences,
    onlyInA,
    onlyInB,
    inputsChanged,
    keysOnlyInA,
    keysOnlyInB,
    newKeys: [...excused],
  };
}

/** The reason two sweeps cannot be compared, or null. A switch flip changes answers under equal inputs. */
export function notComparable(a, b) {
  for (const f of [a, b]) {
    if (f.modeReadFailed || f.mode === undefined || f.planFlagEnforcement === undefined) {
      return "not comparable: a file has no mode or planFlagEnforcement (or its mode read failed)";
    }
  }
  if (a.mode !== b.mode || a.planFlagEnforcement !== b.planFlagEnforcement) {
    return (
      `not comparable: mode ${a.mode} -> ${b.mode}, planFlagEnforcement ` +
      `${a.planFlagEnforcement} -> ${b.planFlagEnforcement}`
    );
  }
  return null;
}

/**
 * Pure (SA-1100 §3.A): classify every (tenant, key) and set row of ONE sweep. Returns
 * `{ agree, gaps: [{ tenant, key }], gapsByKey, unexplained: [{ tenant, key, old, effective, courtesy }], drift }`.
 */
export function checkSweep(file, { afterWp2 = false } = {}) {
  const out = { agree: 0, gaps: [], gapsByKey: {}, unexplained: [], drift: [] };
  for (const t of file.tenants ?? []) {
    if (t.error) {
      out.unexplained.push({
        tenant: t.id,
        key: `(${t.error})`,
        old: null,
        effective: null,
        courtesy: null,
      });
      continue;
    }
    for (const [key, bits] of Object.entries(rowsOf(t))) {
      if (bits.old === bits.effective) out.agree += 1;
      else if (bits.old === true && bits.effective === false && bits.courtesy === true) {
        out.gaps.push({ tenant: t.id, key });
        out.gapsByKey[key] = (out.gapsByKey[key] ?? 0) + 1;
        // after WP2 the evaluator serves the courtesy itself, so a gap is a defect
        if (afterWp2) {
          out.unexplained.push({
            tenant: t.id,
            key,
            old: bits.old,
            effective: bits.effective,
            courtesy: bits.courtesy,
          });
        }
      } else {
        out.unexplained.push({
          tenant: t.id,
          key,
          old: bits.old,
          effective: bits.effective,
          courtesy: bits.courtesy ?? null,
        });
      }
      // after WP2: a row served without strict must carry the courtesy bit, or nothing explains why it is served
      if (
        afterWp2 &&
        bits.old === bits.effective &&
        bits.effective === true &&
        bits.strict === false &&
        bits.courtesy !== true
      ) {
        out.unexplained.push({
          tenant: t.id,
          key,
          old: bits.old,
          effective: bits.effective,
          courtesy: bits.courtesy ?? null,
        });
      }
      const which = bits.clientFlag != null ? "clientFlag" : "clientAddon";
      const client = bits[which];
      // M-8: the client is compared with STRICT, the answer clients are meant to show. A courtesy key the client
      // hides agrees ("hidden by design"). A file with no strict bit falls back to `old`.
      const want = typeof bits.strict === "boolean" ? bits.strict : bits.old;
      if (client !== null && client !== undefined && client !== want) {
        out.drift.push({ tenant: t.id, key, which, old: bits.old, strict: bits.strict, client });
      }
    }
  }
  return out;
}

const readJson = (f) => JSON.parse(readFileSync(path.resolve(f), "utf8"));

/** `--expect wp2` (compare only): the one accepted value; anything else is refused, never ignored. */
function expectOf(args) {
  const at = args.indexOf("--expect");
  if (at < 0) return null;
  const value = args[at + 1];
  if (value !== "wp2")
    refuse(`--expect takes "wp2" (S1 -> S2), got ${JSON.stringify(value ?? null)}`);
  return value;
}

function runCheck(args) {
  if (args.includes("--expect")) refuse("--expect belongs to --compare; --check takes --after-wp2");
  const afterWp2 = args.includes("--after-wp2");
  const file = args[args.indexOf("--check") + 1];
  if (!file || file.startsWith("--")) refuse("--check needs a file: --check a.json");
  const f = readJson(file);
  // A file that cannot show what production is doing is never a pass.
  if ((f.tenants ?? []).length === 0)
    refuse("the file has no tenants (truncated, wrong file or empty)");
  if (f.modeReadFailed) refuse("the API could not read the entitlements mode (modeReadFailed)");
  if (f.mode === undefined || f.planFlagEnforcement === undefined) {
    refuse("the file has no mode or planFlagEnforcement (it must be page 1 of a sweep)");
  }
  const r = checkSweep(f, { afterWp2 });
  console.log(`mode ${f.mode}, planFlagEnforcement ${f.planFlagEnforcement}`);
  const stop = f.mode === "live" || f.planFlagEnforcement === "on";
  if (stop) {
    console.log(
      "WP2-STOP: mode is live or planFlagEnforcement is on; WP2 must not merge, this goes back to the architect",
    );
  }
  for (const u of r.unexplained) {
    console.log(
      `UNEXPLAINED ${u.tenant} ${u.key}: old=${String(u.old)} effective=${String(u.effective)} courtesy=${String(u.courtesy)}`,
    );
  }
  for (const [key, n] of Object.entries(r.gapsByKey).sort()) {
    console.log(`COURTESY-GAP ${key}: ${n}`);
  }
  for (const d of r.drift) {
    console.log(
      `CLIENT-DRIFT ${d.tenant} ${d.key} ${d.which}=${String(d.client)} strict=${String(d.strict)} old=${String(d.old)}`,
    );
  }
  console.log(
    `${r.agree} agree; ${r.gaps.length} courtesy gap(s); ${r.unexplained.length} unexplained; ` +
      `${r.drift.length} client drift (WP8 input, never fails)`,
  );
  process.exit(stop ? 4 : r.unexplained.length > 0 ? 2 : 0);
}

function runCompare(args) {
  if (args.includes("--after-wp2"))
    refuse("--after-wp2 belongs to --check; --compare takes --expect wp2");
  const expect = expectOf(args);
  const at = args.indexOf("--compare");
  const [fileA, fileB] = [args[at + 1], args[at + 2]];
  if (!fileA || !fileB || fileA.startsWith("--") || fileB.startsWith("--")) {
    refuse("--compare needs two files: --compare a.json b.json");
  }
  const nk = args.indexOf("--new-keys");
  const newKeys = nk >= 0 && args[nk + 1] ? args[nk + 1].split(",").filter(Boolean) : [];
  const a = readJson(fileA);
  const b = readJson(fileB);
  const why = notComparable(a, b);
  if (why) refuse(why);
  const r = compareSweeps(a, b, { newKeys, expect });
  for (const d of r.differences) {
    console.log(`DIFF ${d.tenant} ${d.key} ${d.bit}: ${String(d.a)} -> ${String(d.b)}`);
  }
  for (const k of r.keysOnlyInA) console.log(`KEY-ONLY-IN-FIRST ${k}`);
  for (const k of r.keysOnlyInB) {
    console.log(`KEY-ONLY-IN-SECOND ${k} (name it with --new-keys if the build adds it)`);
  }
  console.log(
    `${r.differences.length} difference(s) with unchanged inputs; ${r.inputsChanged} tenant(s) with changed inputs; ` +
      `${r.onlyInA} only in the first file, ${r.onlyInB} only in the second; ` +
      `${r.keysOnlyInA.length + r.keysOnlyInB.length} key(s) in only one file`,
  );
  const bad = r.differences.length > 0 || r.keysOnlyInA.length > 0 || r.keysOnlyInB.length > 0;
  process.exit(bad ? 2 : 0);
}

async function runFetch(args) {
  const base = process.env.ENTITLEMENT_SWEEP_API_URL;
  const token = process.env.ENTITLEMENT_SWEEP_TOKEN;
  if (!base) refuse("set ENTITLEMENT_SWEEP_API_URL (e.g. http://localhost:3000/api/v1)");
  let url;
  try {
    url = new URL(base);
  } catch {
    refuse("ENTITLEMENT_SWEEP_API_URL is not a URL");
  }
  if (!LOCAL_HOSTS.has(url.hostname) && !args.includes(OWNER_FLAG)) {
    refuse(
      `refusing a non-local host; this script never runs against production by itself. ` +
        `The owner may add ${OWNER_FLAG} on that one command.`,
    );
  }
  if (!token) refuse("set ENTITLEMENT_SWEEP_TOKEN (a super-admin access token)");

  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const out = path.resolve(
    ROOT,
    flag("--out", `local-assets/entitlement-sweep-${Date.now()}.json`),
  );
  const assets = path.join(ROOT, "local-assets") + path.sep;
  if (!out.startsWith(assets)) refuse("--out must be a file under local-assets/");
  const limit = flag("--limit", "50");

  const result = {
    mode: undefined,
    planFlagEnforcement: undefined,
    modeReadFailed: undefined,
    tenants: [],
  };
  let cursor = null;
  do {
    const qs = `limit=${encodeURIComponent(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(`${base.replace(/\/+$/, "")}/platform-admin/entitlements/sweep?${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`entitlement-sweep: the API answered ${res.status}`);
      process.exit(1);
    }
    const page = await res.json();
    if (!cursor) {
      result.mode = page.mode;
      result.modeReadFailed = page.modeReadFailed;
      result.planFlagEnforcement = page.planFlagEnforcement;
    }
    result.tenants.push(...page.tenants);
    cursor = page.nextCursor ?? null;
  } while (cursor);

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(
    `wrote ${result.tenants.length} tenant(s) to ${path.relative(ROOT, out)} (mode ${result.mode}, planFlagEnforcement ${result.planFlagEnforcement})`,
  );
}

// Only act when run directly (the pure functions are also importable without side effects).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) runCheck(args);
  else if (args.includes("--compare")) runCompare(args);
  else await runFetch(args);
}
