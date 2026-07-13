import { configuration } from "./configuration";

describe("storage URL signing secret (F5-001 fail-closed)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("throws in production when STORAGE_URL_SIGNING_SECRET is unset (no JWT_SECRET fallback)", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "some-jwt-secret";
    delete process.env.STORAGE_URL_SIGNING_SECRET;

    expect(() => configuration()).toThrow(/STORAGE_URL_SIGNING_SECRET/);
  });

  it("uses the explicit secret verbatim when set (production)", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_URL_SIGNING_SECRET = "an-independent-storage-secret";

    expect(configuration().storage.urlSigningSecret).toBe("an-independent-storage-secret");
  });

  it("derives from JWT_SECRET via HKDF in dev when unset (64 hex chars)", () => {
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = "dev-jwt-secret";
    delete process.env.STORAGE_URL_SIGNING_SECRET;

    expect(configuration().storage.urlSigningSecret).toMatch(/^[0-9a-f]{64}$/);
  });
});
