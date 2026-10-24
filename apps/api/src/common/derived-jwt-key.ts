import { hkdfSync } from "crypto";

/**
 * Per-purpose signing keys for short-lived, single-purpose tokens (OAuth state, email links,
 * Connect state). Each key is HKDF-SHA256(JWT_SECRET, empty salt, info = label) truncated to 32
 * bytes, so a token signed for one purpose is not verifiable with the session key or with another
 * purpose's key. This is the one KDF: the Google OAuth state signer (B349) already used exactly
 * this scheme, so its label and bytes are unchanged.
 *
 * The label set is frozen: changing a label re-keys every token of that purpose.
 */
export const DERIVED_JWT_LABELS = Object.freeze({
  oauthState: "routeflow-oauth-state-v1",
  emailVerify: "email-verify-v1",
  stripeConnectState: "stripe-connect-state-v1",
  /** Reserved; no signer uses it yet. */
  preview: "preview-v1",
} as const);

/** The `aud` each purpose token carries; verifiers require it. */
export const DERIVED_JWT_AUDIENCES = Object.freeze({
  emailVerify: "email-verify",
  stripeConnectState: "stripe-connect-state",
} as const);

export type DerivedJwtLabel = (typeof DERIVED_JWT_LABELS)[keyof typeof DERIVED_JWT_LABELS];

const LABEL_SET: ReadonlySet<string> = new Set(Object.values(DERIVED_JWT_LABELS));

export const DERIVED_JWT_KEY_LENGTH = 32;
export const DERIVED_JWT_SECRET_MIN_LENGTH = 32;

/**
 * Derives the signing key for `label` from the JWT secret. Throws on a missing or short secret:
 * services call this from their constructor, so a bad secret fails the boot (the previous
 * replica keeps serving) instead of surfacing as a request-time error.
 */
export function derivedJwtKey(label: DerivedJwtLabel, secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < DERIVED_JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET is required (at least ${DERIVED_JWT_SECRET_MIN_LENGTH} characters) to derive signing keys`,
    );
  }
  if (!LABEL_SET.has(label)) {
    throw new Error(`Unknown derived key label: ${String(label)}`);
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), label, DERIVED_JWT_KEY_LENGTH));
}
