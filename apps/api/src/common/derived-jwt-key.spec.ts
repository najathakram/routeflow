import * as crypto from "crypto";
import { DERIVED_JWT_LABELS, derivedJwtKey } from "./derived-jwt-key";

const SECRET = "derived-key-test-secret-0123456789abcdef";

// The scheme google-oauth.service.ts has used since B349, restated here as an independent oracle.
function legacyGoogleStateKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "routeflow-oauth-state-v1", 32),
  );
}

describe("derivedJwtKey", () => {
  it("reproduces the bytes the Google state signer derives today (one KDF, pinned)", () => {
    expect(
      derivedJwtKey("routeflow-oauth-state-v1", SECRET).equals(legacyGoogleStateKey(SECRET)),
    ).toBe(true);
  });

  it("returns 32 bytes that differ from the secret itself", () => {
    const key = derivedJwtKey("email-verify-v1", SECRET);
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(SECRET))).toBe(false);
    expect(key.toString("utf8")).not.toBe(SECRET);
  });

  it("is deterministic for a label and distinct across labels", () => {
    const labels = Object.values(DERIVED_JWT_LABELS);
    const keys = labels.map((l) => derivedJwtKey(l, SECRET).toString("hex"));
    expect(new Set(keys).size).toBe(labels.length);
    expect(
      derivedJwtKey("email-verify-v1", SECRET).equals(derivedJwtKey("email-verify-v1", SECRET)),
    ).toBe(true);
  });

  it("changes when the secret changes", () => {
    const other = "another-derived-key-test-secret-0123456789";
    expect(
      derivedJwtKey("email-verify-v1", SECRET).equals(derivedJwtKey("email-verify-v1", other)),
    ).toBe(false);
  });

  it("freezes the label set", () => {
    expect(DERIVED_JWT_LABELS).toEqual({
      oauthState: "routeflow-oauth-state-v1",
      emailVerify: "email-verify-v1",
      stripeConnectState: "stripe-connect-state-v1",
      preview: "preview-v1",
    });
    expect(Object.isFrozen(DERIVED_JWT_LABELS)).toBe(true);
    const values = Object.values(DERIVED_JWT_LABELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each([undefined, null, "", "short-secret"])(
    "refuses a missing or short secret (%p)",
    (bad) => {
      expect(() => derivedJwtKey("email-verify-v1", bad as unknown as string)).toThrow(
        /JWT_SECRET/,
      );
    },
  );

  it("refuses an unknown label", () => {
    expect(() => derivedJwtKey("made-up-v1" as never, SECRET)).toThrow(/label/i);
  });
});
