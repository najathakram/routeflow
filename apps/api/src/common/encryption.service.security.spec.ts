import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "./encryption.service";

/**
 * F5-002 regression: the AES-256-GCM EncryptionService must never persist new
 * secrets under the publicly-known dev placeholder key in production.
 */
describe("EncryptionService (F5-002 secret-at-rest hardening)", () => {
  const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes

  function build(overrides: Record<string, string | undefined>): EncryptionService {
    const config = {
      get: (key: string) => overrides[key],
    } as unknown as ConfigService;
    return new EncryptionService(config);
  }

  it("round-trips when a valid 64-char ENCRYPTION_KEY is set (any env)", () => {
    const svc = build({ ENCRYPTION_KEY: VALID_KEY, nodeEnv: "production" });
    const ciphertext = svc.encrypt("super-secret");
    expect(ciphertext).not.toContain("super-secret");
    expect(svc.decrypt(ciphertext)).toBe("super-secret");
  });

  it("allows encryption with the dev fallback OUTSIDE production", () => {
    const svc = build({ ENCRYPTION_KEY: "", nodeEnv: "development" });
    const ciphertext = svc.encrypt("dev-secret");
    expect(svc.decrypt(ciphertext)).toBe("dev-secret");
  });

  it("REFUSES to encrypt with the placeholder key in production", () => {
    const svc = build({ ENCRYPTION_KEY: "", nodeEnv: "production" });
    expect(() => svc.encrypt("should-not-persist")).toThrow(/ENCRYPTION_KEY/);
  });

  it("does not crash on construction in production without a key (boot stays up)", () => {
    expect(() => build({ ENCRYPTION_KEY: "", nodeEnv: "production" })).not.toThrow();
  });
});
