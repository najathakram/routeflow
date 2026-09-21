/**
 * Fail-closed guard for the Playwright `setup` project (the headless auth mint).
 *
 * WHY: `PLAYWRIGHT_BASE_URL` used to fall back to the PRODUCTION site when unset, so one forgotten
 * inline variable meant the fixture passwords were typed into production's login form. This module
 * makes that impossible to do by omission: an unset/empty/malformed target is REFUSED, never
 * defaulted, and a non-local target is refused unless the run is one of the two sanctioned remote
 * paths (GitHub Actions, or a human who sets E2E_ALLOW_REMOTE_AUTH=1 on purpose).
 *
 * Checks, in order — the first failure wins and names itself so the message says what to fix:
 *   1. base-url-unset   PLAYWRIGHT_BASE_URL absent, empty or whitespace
 *   2. base-url-invalid it does not parse as a URL
 *   3. scheme           the scheme is not http/https
 *   4. non-local        the hostname is not exactly localhost / 127.0.0.1 / ::1 (the URL is PARSED,
 *                       never substring-matched — `localhost.evil.com`, `evil.com/?x=localhost` and
 *                       `localhost@evil.com` are all remote) and no sanctioned remote path applies
 *   5. tenant           the tenant slug is not an approved test tenant (scripts/lib/test-tenants.cjs
 *                       `assertTestTenant` — the single list; never a second one here)
 *
 * HONEST LIMIT: this defeats forgetting and typos. It cannot stop a caller who deliberately sets
 * E2E_ALLOW_REMOTE_AUTH=1 — that variable is for a human at the keyboard and is never for an agent.
 */
import { isLocalUrl } from "./local-url";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/** An environment map. Deliberately NOT NodeJS.ProcessEnv: Next's types make NODE_ENV required there. */
type EnvLike = Record<string, string | undefined>;

export type SetupGuardCheck =
  "base-url-unset" | "base-url-invalid" | "scheme" | "non-local" | "tenant";

export interface SetupTargetInput {
  /** process.env.PLAYWRIGHT_BASE_URL */
  baseUrl?: string;
  /** process.env.PLAYWRIGHT_TENANT_SLUG — unset means the standing `e2e-routeflow` tenant. */
  tenantSlug?: string;
  /** process.env.GITHUB_ACTIONS — "true" on a GitHub-hosted runner. */
  githubActions?: string;
  /** process.env.E2E_ALLOW_REMOTE_AUTH — "1" is a human's explicit, per-run opt-in. */
  allowRemote?: string;
}

export type SetupTargetResult =
  | { ok: true; baseUrl: string; tenantSlug: string; remote: boolean }
  | { ok: false; check: SetupGuardCheck; message: string };

export class SetupGuardError extends Error {
  constructor(
    readonly check: SetupGuardCheck,
    message: string,
  ) {
    super(message);
    this.name = "SetupGuardError";
  }
}

const DEFAULT_TENANT = "e2e-routeflow";

const NEVER_PROD =
  "Do NOT 'fix' this by pointing PLAYWRIGHT_BASE_URL at production or any deployed host.";

const UNSET_DETAIL =
  "PLAYWRIGHT_BASE_URL is not set. There is no default — the old default was the production " +
  "site. Set it explicitly to the local stack (http://localhost:3001) before running. " +
  NEVER_PROD;

const refuseText = (check: SetupGuardCheck, message: string): string =>
  `[e2e setup guard] REFUSED (${check}): ${message}`;

const refuse = (check: SetupGuardCheck, message: string): SetupTargetResult => ({
  ok: false,
  check,
  message: refuseText(check, message),
});

export function evaluateSetupTarget(input: SetupTargetInput): SetupTargetResult {
  const raw = input.baseUrl;
  if (raw === undefined || raw.trim() === "") return refuse("base-url-unset", UNSET_DETAIL);

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse(
      "base-url-invalid",
      `PLAYWRIGHT_BASE_URL is not a valid URL (${JSON.stringify(raw)}). Use http://localhost:3001.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse(
      "scheme",
      `PLAYWRIGHT_BASE_URL uses the "${url.protocol}" scheme; only http/https targets are allowed.`,
    );
  }

  const local = isLocalUrl(url.href);
  const remoteAllowed = input.githubActions === "true" || input.allowRemote === "1";
  if (!local && !remoteAllowed) {
    return refuse(
      "non-local",
      `"${url.hostname}" is not a local host (only localhost, 127.0.0.1 or ::1 are). Authenticating ` +
        "against a non-local target is a human-only action: an agent must NEVER do it and must " +
        "NEVER set E2E_ALLOW_REMOTE_AUTH. Run the local stack (npm run local:up) and target " +
        `http://localhost:3001. ${NEVER_PROD}`,
    );
  }

  const slug = input.tenantSlug === undefined ? DEFAULT_TENANT : input.tenantSlug;
  try {
    assertTestTenant(slug, "e2e setup guard");
  } catch (e) {
    return refuse(
      "tenant",
      `tenant ${JSON.stringify(slug)} is not an approved test tenant — a live client tenant is ` +
        `never a test target. ${(e as Error).message}`,
    );
  }

  return { ok: true, baseUrl: url.href, tenantSlug: slug, remote: !local };
}

/** Throws SetupGuardError when the target is unsafe; returns the vetted target otherwise. */
export function assertSafeSetupTarget(
  input: SetupTargetInput = envInput(process.env),
): Extract<SetupTargetResult, { ok: true }> {
  const result = evaluateSetupTarget(input);
  if (!result.ok) throw new SetupGuardError(result.check, result.message);
  return result;
}

/**
 * Config-level rule (every project, not just setup): the base URL is REQUIRED — no default.
 * Returns it untouched (the caller's own string) when present; throws when unset or empty.
 */
export function requireBaseUrl(env: EnvLike = process.env): string {
  const value = env.PLAYWRIGHT_BASE_URL;
  if (value === undefined || value.trim() === "") {
    throw new SetupGuardError("base-url-unset", refuseText("base-url-unset", UNSET_DETAIL));
  }
  return value;
}

export function envInput(env: EnvLike): SetupTargetInput {
  return {
    baseUrl: env.PLAYWRIGHT_BASE_URL,
    tenantSlug: env.PLAYWRIGHT_TENANT_SLUG,
    githubActions: env.GITHUB_ACTIONS,
    allowRemote: env.E2E_ALLOW_REMOTE_AUTH,
  };
}
