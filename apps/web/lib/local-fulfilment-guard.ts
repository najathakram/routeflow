import { isLocalUrl } from "./local-url";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { localConnectionConfig } = require("../../api/scripts/lib/local-db-target.cjs");

/**
 * B1210 (spec 71): the spec changes the e2e tenant's FULFILMENT CONFIG with a super-admin write (a business profile)
 * and puts it back afterwards. That is acceptable only on the local compose stack against an approved test tenant, so
 * every write is preceded by this guard, which THROWS (never warns) unless ALL hold:
 *   - the web base URL and the API origin are localhost / 127.0.0.1 / ::1 (parsed, never substring-matched),
 *   - the database URL is provably local (the same allowlist the seeds use),
 *   - the tenant slug is an approved test tenant (scripts/lib/test-tenants.cjs),
 *   - the run is not a GitHub Actions run.
 * There is no override. Super-admin credentials come from the environment only and are never written anywhere.
 */
export interface LocalFulfilmentTarget {
  baseUrl?: string;
  apiUrl?: string;
  dbUrl?: string;
  tenantSlug?: string;
  githubActions?: string;
}

export function assertLocalFulfilmentTarget(t: LocalFulfilmentTarget): void {
  const refuse = (why: string): never => {
    throw new Error(
      `[local fulfilment guard] REFUSED: ${why}. This spec rewrites a tenant's fulfilment config and only runs ` +
        `against the local compose stack (npm run local:e2e style) on an approved test tenant. It never touches a deployed host.`,
    );
  };
  if (t.githubActions === "true") refuse("running on GitHub Actions");
  if (!isLocalUrl(t.baseUrl)) refuse(`the web base URL is not local (${t.baseUrl ?? "unset"})`);
  if (!isLocalUrl(t.apiUrl)) refuse(`the API origin is not local (${t.apiUrl ?? "unset"})`);
  if (!localConnectionConfig(t.dbUrl)) refuse("the database URL is not provably local (or unset)");
  assertTestTenant(t.tenantSlug ?? "", "B1210 spec 71 fulfilment-config write");
}

/** True only for a local, non-CI run: playwright.config.ts registers the spec-71 project on this and nothing else. */
export function isLocalOnlyLane(env: Record<string, string | undefined>): boolean {
  return isLocalUrl(env.PLAYWRIGHT_BASE_URL) && env.GITHUB_ACTIONS !== "true";
}
