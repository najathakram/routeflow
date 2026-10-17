import { assertWebBaseUrlAtBoot, webBaseUrl } from "./web-base-url";

/**
 * A live tenant paid through the catch-up Checkout and Stripe sent them to http://localhost:3001/... because the API read
 * `FRONTEND_URL ?? "http://localhost:3001"` and the production service had only WEB_URL. One helper decides the web base
 * for every user-facing link; in production it never defaults.
 */
const prod = (extra: Record<string, string | undefined> = {}) =>
  ({ NODE_ENV: "production", ...extra }) as NodeJS.ProcessEnv;

describe("webBaseUrl", () => {
  it("prefers WEB_URL, then FRONTEND_URL", () => {
    expect(webBaseUrl(prod({ WEB_URL: "https://a.test", FRONTEND_URL: "https://b.test" }))).toBe(
      "https://a.test",
    );
    expect(webBaseUrl(prod({ FRONTEND_URL: "https://b.test" }))).toBe("https://b.test");
  });

  it("strips trailing slashes and surrounding spaces", () => {
    expect(webBaseUrl(prod({ WEB_URL: " https://a.test/// " }))).toBe("https://a.test");
  });

  it("outside production the local default is still available", () => {
    expect(webBaseUrl({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(
      "http://localhost:3001",
    );
    expect(webBaseUrl({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("http://localhost:3001");
  });

  it("in production a missing value throws, it never defaults", () => {
    expect(() => webBaseUrl(prod())).toThrow(/WEB_URL/);
    expect(() => webBaseUrl(prod({ WEB_URL: "  ", FRONTEND_URL: "" }))).toThrow(/WEB_URL/);
  });

  it.each([
    "http://localhost:3001",
    "http://LOCALHOST",
    "http://127.0.0.1:3001",
    "http://0.0.0.0:3001",
    "http://[::1]:3001",
    "http://app.localhost",
  ])("in production a loopback value (%s) throws", (value) => {
    expect(() => webBaseUrl(prod({ WEB_URL: value }))).toThrow(/localhost|loopback/i);
  });

  it("in production a value that is not an absolute http(s) URL throws", () => {
    expect(() => webBaseUrl(prod({ WEB_URL: "app.example.com" }))).toThrow(/absolute/i);
  });

  it("assertWebBaseUrlAtBoot exports the resolved base into WEB_URL so every reader sees it", () => {
    const env = prod({ FRONTEND_URL: "https://only-frontend.test/" });
    assertWebBaseUrlAtBoot(env);
    expect(env.WEB_URL).toBe("https://only-frontend.test");
    expect(() => assertWebBaseUrlAtBoot(prod())).toThrow(/WEB_URL/);
  });
});
