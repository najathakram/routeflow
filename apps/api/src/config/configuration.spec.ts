import { Logger } from "@nestjs/common";
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
    process.env.WEB_URL = "https://www.routeflow.test";
    process.env.JWT_SECRET = "some-jwt-secret";
    delete process.env.STORAGE_URL_SIGNING_SECRET;

    expect(() => configuration()).toThrow(/STORAGE_URL_SIGNING_SECRET/);
  });

  it("uses the explicit secret verbatim when set (production)", () => {
    process.env.NODE_ENV = "production";
    process.env.WEB_URL = "https://www.routeflow.test";
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

describe("web base URL (fail-closed in production)", () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("boot validation fails in production when neither WEB_URL nor FRONTEND_URL is set", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_URL_SIGNING_SECRET = "an-independent-storage-secret";
    delete process.env.WEB_URL;
    delete process.env.FRONTEND_URL;
    expect(() => configuration()).toThrow(/WEB_URL/);
  });

  it("boot validation fails in production when the URL is a loopback", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_URL_SIGNING_SECRET = "an-independent-storage-secret";
    process.env.WEB_URL = "http://localhost:3001";
    expect(() => configuration()).toThrow(/localhost|loopback/i);
  });

  it("urls.web is the configured base in production", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_URL_SIGNING_SECRET = "an-independent-storage-secret";
    process.env.WEB_URL = "https://www.routeflow.info/";
    expect(configuration().urls.web).toBe("https://www.routeflow.info");
  });
});

describe("DEFAULT_THROTTLE_LIMIT parsing (bounded 1..10000, else 100)", () => {
  const ORIGINAL_ENV = process.env;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "development", JWT_SECRET: "dev-jwt-secret" };
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("unset -> 100 with no warning", () => {
    delete process.env.DEFAULT_THROTTLE_LIMIT;
    expect(configuration().throttle.defaultLimit).toBe(100);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["0", "-5", "abc", "1.5", "99999999", "10001"])(
    "%s -> 100 with exactly one warning",
    (raw) => {
      process.env.DEFAULT_THROTTLE_LIMIT = raw;
      expect(configuration().throttle.defaultLimit).toBe(100);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["250", 250],
    ["10000", 10000],
    ["1", 1],
  ])("%s -> %i with no warning", (raw, expected) => {
    process.env.DEFAULT_THROTTLE_LIMIT = raw;
    expect(configuration().throttle.defaultLimit).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });
});
