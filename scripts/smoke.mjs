#!/usr/bin/env node
/**
 * RouteFlow smoke test — a fast liveness check against a running API.
 *
 * Hits the health endpoint plus a couple of unauthenticated routes to confirm
 * the service booted, is reachable, and answers. Intended for:
 *   - post-deploy verification (CI / Railway): `SMOKE_BASE_URL=https://… npm run smoke`
 *   - local sanity check against `node dist/main.js`: `npm run smoke` (defaults to :3000)
 *
 * Zero dependencies — uses the global `fetch` shipped with Node ≥ 18.
 * Exits 0 when every check passes, 1 otherwise (CI-friendly).
 */

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

/** @type {{ name: string, path: string, expect: (res: Response, body: string) => boolean }[]} */
const checks = [
  {
    name: "API health",
    path: "/api/v1/health",
    expect: (res, body) => res.ok && /ok|healthy|up|status/i.test(body),
  },
  {
    // Public tenants endpoint — confirms the DB + tenant layer answer (any 2xx).
    name: "Public tenants",
    path: "/api/v1/public/tenants",
    expect: (res) => res.status < 500,
  },
];

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function run() {
  console.log(`\n🔎 RouteFlow smoke — ${BASE}\n`);
  let failures = 0;

  for (const check of checks) {
    const url = `${BASE}${check.path}`;
    try {
      const res = await withTimeout(
        (signal) => fetch(url, { signal, headers: { accept: "application/json" } }),
        TIMEOUT_MS,
      );
      const body = await res.text();
      const ok = check.expect(res, body);
      console.log(`  ${ok ? "✅" : "❌"} ${check.name} — ${res.status} ${check.path}`);
      if (!ok) failures++;
    } catch (err) {
      console.log(`  ❌ ${check.name} — ${err?.name === "AbortError" ? "timeout" : err?.message}`);
      failures++;
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(`💥 Smoke FAILED — ${failures} check(s) failed against ${BASE}\n`);
    process.exit(1);
  }
  console.log(`✨ Smoke passed — ${checks.length} check(s) OK\n`);
}

run().catch((err) => {
  console.error("💥 Smoke crashed:", err);
  process.exit(1);
});
