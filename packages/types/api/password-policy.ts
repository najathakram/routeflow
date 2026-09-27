/**
 * #2429: THE password policy every password form enforces — web and mobile import this; the API
 * keeps a LOCAL copy (apps/api/src/common/password-policy.ts, pinned equal by
 * password-policy.parity.spec.ts) because it cannot value-import this raw-TS package at runtime.
 *
 * A valid password has at least PASSWORD_MIN_LENGTH characters, a lowercase letter, an uppercase
 * letter, and a number or a special (non-word) character. `_` is a WORD character, not a special.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** The server's own `@Matches` pattern (length is checked separately, by MinLength). */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/;

/** One sentence describing the whole policy, for hints under a password field. */
export const PASSWORD_POLICY_HINT =
  "At least 8 characters, with an uppercase letter, a lowercase letter, and a number or special character.";

/**
 * Every rule `password` breaks, as short user-facing messages (empty = valid). Per rule, so a form
 * can show exactly what is missing; equivalent to MinLength + PASSWORD_POLICY_PATTERN (pinned).
 */
export function passwordPolicyErrors(password: string): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) errors.push("Must contain a lowercase letter");
  if (!/[A-Z]/.test(password)) errors.push("Must contain an uppercase letter");
  if (!/[\d\W]/.test(password)) errors.push("Must contain a number or special character");
  return errors;
}
