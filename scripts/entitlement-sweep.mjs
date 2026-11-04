#!/usr/bin/env node
// FG-1 WP1 (R10, R11) — fetch the entitlement sweep from an API and compare two sweep files.
//
//   fetch:    ENTITLEMENT_SWEEP_API_URL=http://localhost:3000/api/v1 \
//             ENTITLEMENT_SWEEP_TOKEN=<super-admin access token> \
//             node scripts/entitlement-sweep.mjs [--out local-assets/entitlement-sweep-a.json] [--limit 50]
//   compare:  node scripts/entitlement-sweep.mjs --compare a.json b.json
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
// Compare exit codes: 0 equal, or every difference comes with a changed inputsHash (the tenant's
// plan, plan version, add-on rows or override rows moved, so a different answer is expected);
// 2 when any (hashed tenant, key) bit differs while that tenant's inputsHash is unchanged;
// 3 refused (bad URL, missing env, path outside local-assets); 1 any other failure.
// The report prints only hashed tenant ids and key names.
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

/** Pure: `{ differences: [{ tenant, key, bit, a, b }], onlyInA, onlyInB, inputsChanged }`. */
export function compareSweeps(a, b) {
  const byId = (file) => new Map((file.tenants ?? []).map((t) => [t.id, t]));
  const ma = byId(a);
  const mb = byId(b);
  const differences = [];
  let inputsChanged = 0;
  const rows = (t) => ({
    ...(t.keys ?? {}),
    ...Object.fromEntries(Object.entries(t.sets ?? {}).map(([k, v]) => [`set:${k}`, v])),
  });
  for (const [id, ta] of ma) {
    const tb = mb.get(id);
    if (!tb) continue;
    if (ta.inputsHash !== tb.inputsHash) {
      inputsChanged += 1;
      continue;
    }
    const ra = rows(ta);
    const rb = rows(tb);
    for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      for (const bit of BITS) {
        const va = ra[key]?.[bit];
        const vb = rb[key]?.[bit];
        if (va !== vb) differences.push({ tenant: id, key, bit, a: va, b: vb });
      }
    }
  }
  const onlyInA = [...ma.keys()].filter((id) => !mb.has(id)).length;
  const onlyInB = [...mb.keys()].filter((id) => !ma.has(id)).length;
  return { differences, onlyInA, onlyInB, inputsChanged };
}

function runCompare(fileA, fileB) {
  if (!fileA || !fileB) refuse("--compare needs two files: --compare a.json b.json");
  const read = (f) => JSON.parse(readFileSync(path.resolve(f), "utf8"));
  const a = read(fileA);
  const b = read(fileB);
  const r = compareSweeps(a, b);
  for (const d of r.differences) {
    console.log(`DIFF ${d.tenant} ${d.key} ${d.bit}: ${String(d.a)} -> ${String(d.b)}`);
  }
  if (a.mode !== b.mode || a.planFlagEnforcement !== b.planFlagEnforcement) {
    console.log(
      `note: mode ${a.mode} -> ${b.mode}, planFlagEnforcement ${a.planFlagEnforcement} -> ${b.planFlagEnforcement}`,
    );
  }
  console.log(
    `${r.differences.length} difference(s) with unchanged inputs; ${r.inputsChanged} tenant(s) with changed inputs; ` +
      `${r.onlyInA} only in the first file, ${r.onlyInB} only in the second`,
  );
  process.exit(r.differences.length > 0 ? 2 : 0);
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

  const result = { mode: undefined, planFlagEnforcement: undefined, tenants: [] };
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

// Only act when run directly (compareSweeps is also importable without side effects).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--compare");
  if (at >= 0) runCompare(args[at + 1], args[at + 2]);
  else await runFetch(args);
}
