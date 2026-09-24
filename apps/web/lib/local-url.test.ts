import { isLocalUrl } from "./local-url";

describe("isLocalUrl (e2e buyer setup gate)", () => {
  it.each([
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001/x",
    "HTTP://LOCALHOST",
  ])("is local: %s", (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });

  it("is NOT local for an unset base URL, so the step skips and makes no request", () => {
    expect(isLocalUrl(undefined)).toBe(false);
    expect(isLocalUrl("")).toBe(false);
  });

  it.each([
    // The value PLAYWRIGHT_BASE_URL resolves to when it is unset (playwright.config.ts).
    "https://routeflowweb-production.up.railway.app",
    "https://api.example.com",
    "http://localhost.evil.com",
    "http://localhost@evil.com",
    "not a url",
  ])("is NOT local: %s", (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });
});
