/**
 * #2159 S2 / SA-456: the ONE minimum length for ONBOARDING_TOKEN_SECRET. Boot (`assertSecrets`)
 * and every request-time use read this same constant, so the two can never disagree about what
 * "configured" means.
 */
export const ONBOARDING_TOKEN_SECRET_MIN_LENGTH = 32;

/** The configured secret, or null when it is unset or shorter than the minimum. */
export function onboardingTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.ONBOARDING_TOKEN_SECRET ?? "").trim();
  return secret.length >= ONBOARDING_TOKEN_SECRET_MIN_LENGTH ? secret : null;
}
