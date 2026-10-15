import {
  ONBOARDING_TOKEN_SECRET_MIN_LENGTH,
  onboardingTokenSecret,
} from "./onboarding/onboarding-token-secret";
import {
  HANDOFF_TOKEN_SECRET_MIN_LENGTH,
  handoffTokenSecret,
} from "./auth/handoff/handoff-code.service";

export interface AssertSecretsIo {
  exit: (code: number) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

const defaultIo: AssertSecretsIo = {
  exit: (code) => process.exit(code),
  error: (message) => console.error(message),
  warn: (message) => console.warn(message),
};

/**
 * Boot-time secret check, called first thing in `bootstrap()`. Extracted from main.ts so it can
 * be specced without booting the app (SA-456); `env` / `io` are injectable for that reason only.
 */
export function assertSecrets(
  env: NodeJS.ProcessEnv = process.env,
  io: AssertSecretsIo = defaultIo,
): void {
  const isProd = env.NODE_ENV === "production";
  const missing: string[] = [];
  if (!env.JWT_SECRET) missing.push("JWT_SECRET");
  if (!env.JWT_REFRESH_SECRET) missing.push("JWT_REFRESH_SECRET");
  // F5-001: in production the storage-URL signing secret MUST be set independently.
  // Without it the key was derived from JWT_SECRET, so a JWT_SECRET leak let an
  // attacker forge signed file-access URLs cross-tenant. Fail closed instead.
  if (isProd && !env.STORAGE_URL_SIGNING_SECRET) {
    missing.push("STORAGE_URL_SIGNING_SECRET");
  }
  // #2159 S2: the onboarding intake links are signed with their OWN secret (never derived from
  // JWT_SECRET), so a JWT_SECRET leak can't forge a link. Production fails closed; elsewhere an
  // unset or short secret disables the feature (issuing a link refuses, every link reads 404) —
  // and says so loudly below (SA-456).
  const onboardingSecretOk = onboardingTokenSecret(env) !== null;
  if (isProd && !onboardingSecretOk) {
    missing.push(`ONBOARDING_TOKEN_SECRET (${ONBOARDING_TOKEN_SECRET_MIN_LENGTH}+ chars)`);
  }
  if (missing.length > 0) {
    io.error(`\n❌ FATAL: Missing required environment variables: ${missing.join(", ")}`);
    io.error("   These must be set before the API can start.\n");
    io.exit(1);
    return;
  }

  if (!onboardingSecretOk) {
    io.warn(
      `\n⚠️  ONBOARDING_TOKEN_SECRET is unset or shorter than ${ONBOARDING_TOKEN_SECRET_MIN_LENGTH} chars — onboarding intake links are DISABLED (issuing a link refuses, every link reads 404)\n`,
    );
  }

  // #2653 (SA-542a): the in-app sign-in handoff signs its codes with its OWN secret. It is NOT a
  // boot requirement in any environment: without it the feature is off (mint answers 409
  // HANDOFF_NOT_CONFIGURED, so the shell falls back to the web login) and the API still boots.
  if (handoffTokenSecret(env) === null) {
    io.warn(
      `\n⚠️  HANDOFF_TOKEN_SECRET is unset or shorter than ${HANDOFF_TOKEN_SECRET_MIN_LENGTH} chars — the in-app sign-in handoff is DISABLED (mint answers 409 HANDOFF_NOT_CONFIGURED)\n`,
    );
  }

  // F5-002: warn (do NOT crash) when ENCRYPTION_KEY is unset in production —
  // encrypt() self-disables so the app can still boot for non-encryption paths.
  if (isProd) {
    const encKey = env.ENCRYPTION_KEY ?? "";
    if (encKey.length !== 64) {
      io.warn(
        "\n⚠️  Production secret not fully configured: ENCRYPTION_KEY (expected 64 hex chars)\n",
      );
    }
  }
}
