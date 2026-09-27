import { hashSignedToken, mintSignedToken, verifySignedToken } from "./signed-token";

const SECRET = "test-secret-at-least-16-chars";

describe("signed-token (lifted from demo-booking; shared with onboarding intake links)", () => {
  it("mints <random>.<hmac> tokens that verify under the same secret only", () => {
    const t = mintSignedToken(SECRET);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifySignedToken(t, SECRET)).toBe(true);
    expect(verifySignedToken(t, "another-secret-16-chars-long")).toBe(false);
  });

  it("rejects a tampered nonce, a tampered MAC, a token with no separator, and junk", () => {
    const t = mintSignedToken(SECRET);
    const [nonce, mac] = t.split(".");
    expect(verifySignedToken(`x${nonce}.${mac}`, SECRET)).toBe(false);
    // Swap the MAC's last character for a DIFFERENT one: a fixed "A" was a no-op 1 run in 64.
    const last = mac.slice(-1) === "A" ? "B" : "A";
    expect(verifySignedToken(`${nonce}.${mac.slice(0, -1)}${last}`, SECRET)).toBe(false);
    expect(verifySignedToken(`${nonce}${mac}`, SECRET)).toBe(false);
    expect(verifySignedToken(".abc", SECRET)).toBe(false);
    expect(verifySignedToken("", SECRET)).toBe(false);
    expect(verifySignedToken(undefined as unknown as string, SECRET)).toBe(false);
    expect(verifySignedToken(t, "")).toBe(false);
  });

  it("never mints with a missing or short secret", () => {
    expect(() => mintSignedToken("")).toThrow();
    expect(() => mintSignedToken("short")).toThrow();
  });

  it("hashes the WHOLE token (sha-256 hex) and never returns the token itself", () => {
    const t = mintSignedToken(SECRET);
    const h = hashSignedToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t.split(".")[0]);
    expect(hashSignedToken(t)).toBe(h);
  });
});
