/**
 * #2429: the API's LOCAL copy of the ONE password policy (packages/types/api/password-policy.ts).
 * The API cannot value-import @routeflow/types at runtime — its entry is raw TypeScript and `nest
 * build` would emit `require("@routeflow/types")` into dist (see common/check-transitions.ts).
 * password-policy.parity.spec.ts pins these values equal to the shared ones and the DTO validation
 * equal to the clients' passwordPolicyErrors. Every password DTO uses these — never its own regex.
 */
export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/;

export const PASSWORD_POLICY_DESCRIPTION =
  "Min 8 chars, must contain uppercase, lowercase, and number or special character";

/** The `@Matches` message for the DTO field `field`. */
export const passwordPolicyMessage = (field: string): string =>
  `${field} must contain at least one uppercase letter, one lowercase letter, and one number or special character`;
