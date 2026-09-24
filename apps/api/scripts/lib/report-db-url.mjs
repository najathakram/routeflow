import { resolveDatabaseUrl, redactUrl } from "./railway-db-url.mjs";

/**
 * B768: the ONE connection-string resolution for owner-run READ-ONLY reports.
 *
 * Under `railway run --service postgres`, DATABASE_URL is the *.railway.internal host, which is
 * unreachable from the owner's machine; the reachable one is built from Railway's TCP-proxy
 * variables. `resolveDatabaseUrl` (railway-db-url.mjs) lets those proxy variables WIN whenever
 * they are present, so every report reaches the same public proxy host `prod-migrate.mjs` uses.
 *
 * REPORT_REQUIRE_PROXY decides what happens when the proxy variables are ABSENT:
 *   false — fall back to DATABASE_URL (a local docker-compose run against localhost still works).
 *           This is railway-db-url.mjs's documented contract for read-only tools: requireProxy is
 *           for schema WRITERS. A wrong-target fallback here is a READ, never a write, and the
 *           redacted target is printed before anything is read.
 *   true  — refuse; these reports then run only through `railway run`.
 * Every report below reads this one constant, so changing the policy is a one-line change.
 *
 * The target is logged to STDERR so machine-readable stdout (e.g. `--json`) stays clean.
 * CommonJS reports load this with `await import(...)` inside their async main: CI pins Node 20,
 * where require() of an ES module is not safe to rely on.
 */
export const REPORT_REQUIRE_PROXY = false;

/**
 * Resolve the database URL for `scriptName`, logging the redacted target. Returns null (after
 * logging why) when nothing usable is configured — the caller exits non-zero without connecting.
 */
export function resolveReportDbUrl(scriptName, { env = process.env, log = console.error } = {}) {
  let url;
  try {
    url = resolveDatabaseUrl(env, { requireProxy: REPORT_REQUIRE_PROXY });
  } catch (e) {
    log(`${scriptName}: ${e.message}`);
    return null;
  }
  log(`${scriptName}: target ${redactUrl(url)} (READ ONLY)`);
  return url;
}
