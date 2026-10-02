// W3 (dead-weight): READ-ONLY report of API routes that had ZERO calls over the last N days, among the
// 111 routes the audit found with no in-repo caller (apps/api/scripts/data/no-caller-routes.json).
//
// WHAT THE COUNTS ARE: the route hit counter (apps/api/src/route-hits) counts AUTHENTICATED/ALLOWED calls,
// per route TEMPLATE, per UTC day, tenant-agnostic. Calls refused by a guard (401/403) or throttled never
// reach the counter and are NOT counted. Counts are best effort: a replica loses at most ~10 s of counts
// on a crash or shutdown, each replica flushes independently (the totals add up), and a Redis that does not
// persist loses the day's bucket on restart. A day with no bucket is UNOBSERVED, never "zero".
//
// OUTPUT: route templates + the audit's dead-confidence + counts only. No tenant, user, IP, URL or payload
// exists in the data, so none can be printed. Read-only: only HGETALL is ever issued (the client is wrapped,
// and the self-test proves any other command throws).
//
//   node apps/api/scripts/report-zero-call-routes.mjs --self-test
//   REDIS_URL=redis://… node apps/api/scripts/report-zero-call-routes.mjs --days 14      # owner-run
//   railway run --service <redis-service> node apps/api/scripts/report-zero-call-routes.mjs --days 14
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "report-zero-call-routes";
const HERE = dirname(fileURLToPath(import.meta.url));
export const KEY_PREFIX = "rf:route-hits:";
export const DROPPED_FIELD = "__DROPPED__";
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export function loadNoCallerRoutes(file = resolve(HERE, "data/no-caller-routes.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** `rf:route-hits:YYYY-MM-DD` for each of the last `n` UTC days, newest first. */
export function dayKeys(now, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(`${KEY_PREFIX}${d.toISOString().slice(0, 10)}`);
  }
  return out;
}

/**
 * Pure: `dayHashes` is an array of { key, hash|null } (null/empty = no bucket = UNOBSERVED day).
 * Returns the routes with zero hits across the OBSERVED days, plus the coverage.
 */
export function summarize(routes, dayHashes, windowDays) {
  const observed = dayHashes.filter((d) => d.hash && Object.keys(d.hash).length > 0);
  const totals = new Map();
  let dropped = 0;
  for (const { hash } of observed) {
    for (const [field, value] of Object.entries(hash)) {
      if (field === DROPPED_FIELD) dropped += Number(value) || 0;
      else totals.set(field, (totals.get(field) ?? 0) + (Number(value) || 0));
    }
  }
  const zero = routes.filter((r) => (totals.get(r.route) ?? 0) === 0);
  return {
    windowDays,
    observedDays: observed.length,
    conclusive: observed.length >= windowDays,
    dropped,
    zero,
    totalRoutes: routes.length,
  };
}

/** Wraps a Redis client so ONLY the read this report needs can ever be issued. */
export function readOnlyRedis(client) {
  return {
    hgetall: (key) => client.hgetall(key),
    quit: () => client.quit(),
  };
}

export function render(summary) {
  const lines = [
    `${TAG}: counts = authenticated/allowed calls per route TEMPLATE (401/403 and throttled calls are not counted)`,
    `${TAG}: window ${summary.windowDays} day(s); observed ${summary.observedDays} of ${summary.windowDays} (a day with no bucket is unobserved, not zero)`,
  ];
  if (!summary.conclusive) {
    lines.push(
      `${TAG}: WARNING only ${summary.observedDays}/${summary.windowDays} days observed: zero is NOT conclusive yet`,
    );
  }
  if (summary.dropped > 0)
    lines.push(`${TAG}: WARNING the counter dropped ${summary.dropped} key(s)`);
  lines.push(
    `${TAG}: ${summary.zero.length} of ${summary.totalRoutes} no-caller routes had zero calls`,
  );
  for (const r of summary.zero) lines.push(`  [${r.deadConfidence}] ${r.route}`);
  lines.push(`${TAG}: read-only, nothing was written`);
  return lines.join("\n");
}

async function main() {
  const days = Number(argOf("--days") ?? 14);
  if (!Number.isInteger(days) || days < 1 || days > 45) {
    console.error(`${TAG}: --days must be an integer 1..45`);
    return 1;
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error(`${TAG}: set REDIS_URL (run under 'railway run' against the Redis service)`);
    return 2;
  }
  const { default: Redis } = await import("ioredis");
  const raw = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  const redis = readOnlyRedis(raw);
  try {
    const dayHashes = [];
    for (const key of dayKeys(new Date(), days)) {
      dayHashes.push({ key, hash: await redis.hgetall(key) });
    }
    console.log(render(summarize(loadNoCallerRoutes(), dayHashes, days)));
    return 0;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function selfTest() {
  const routes = [
    { route: "GET /api/v1/a/:id", deadConfidence: "high" },
    { route: "POST /api/v1/b", deadConfidence: "medium" },
  ];
  const cases = [
    [
      "dayKeys: n UTC days, newest first",
      () => {
        const k = dayKeys(new Date("2026-10-02T03:00:00Z"), 3);
        return (
          k.join() === `${KEY_PREFIX}2026-10-02,${KEY_PREFIX}2026-10-01,${KEY_PREFIX}2026-09-30`
        );
      },
    ],
    [
      "summarize: a route with hits is not zero; an unobserved day is not counted as zero",
      () => {
        const s = summarize(
          routes,
          [
            { key: "d1", hash: { "GET /api/v1/a/:id": "3" } },
            { key: "d2", hash: null },
          ],
          2,
        );
        return (
          s.zero.length === 1 &&
          s.zero[0].route === "POST /api/v1/b" &&
          s.observedDays === 1 &&
          s.conclusive === false
        );
      },
    ],
    [
      "summarize: conclusive only when every day of the window is observed",
      () =>
        summarize(
          routes,
          [
            { key: "d1", hash: { x: "1" } },
            { key: "d2", hash: { x: "1" } },
          ],
          2,
        ).conclusive === true,
    ],
    [
      "summarize: the dropped-keys field is surfaced and is never a route",
      () => {
        const s = summarize(routes, [{ key: "d1", hash: { [DROPPED_FIELD]: "4" } }], 1);
        return s.dropped === 4 && s.zero.length === 2;
      },
    ],
    [
      "render: states what the counts are and prints templates only",
      () => {
        const out = render(summarize(routes, [{ key: "d1", hash: null }], 1));
        return (
          /authenticated\/allowed calls/.test(out) &&
          /401\/403 and throttled calls are not counted/.test(out) &&
          /zero is NOT conclusive/.test(out) &&
          /\[high\] GET \/api\/v1\/a\/:id/.test(out)
        );
      },
    ],
    [
      "readOnlyRedis: hgetall passes through; ANY other command is absent (so it cannot be called)",
      () => {
        const calls = [];
        const wrapped = readOnlyRedis({
          hgetall: (k) => (calls.push(k), {}),
          quit: () => undefined,
          set: () => {
            throw new Error("WRITE");
          },
        });
        wrapped.hgetall("k");
        return (
          calls.length === 1 &&
          wrapped.set === undefined &&
          wrapped.del === undefined &&
          wrapped.hincrby === undefined &&
          wrapped.eval === undefined &&
          wrapped.pipeline === undefined &&
          Object.keys(wrapped).sort().join() === "hgetall,quit"
        );
      },
    ],
    [
      "the checked-in route list has 111 unique METHOD /api/v1 routes with a confidence",
      () => {
        const list = loadNoCallerRoutes();
        const unique = new Set(list.map((r) => r.route));
        return (
          list.length === 111 &&
          unique.size === 111 &&
          list.every(
            (r) =>
              /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//.test(r.route) &&
              ["high", "medium", "low"].includes(r.deadConfidence),
          )
        );
      },
    ],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    const ok = fn();
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  }
  console.log(
    failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${cases.length} passed`,
  );
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const run = process.argv.includes("--self-test") ? Promise.resolve(selfTest()) : main();
  run.then(
    (code) => process.exit(code),
    (e) => {
      console.error(`${TAG}: ${e.message}`);
      process.exit(2);
    },
  );
}
