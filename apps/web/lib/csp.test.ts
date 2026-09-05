import { apiConnectSources, buildContentSecurityPolicy } from "../csp.mjs";

// Oracle: the exact production Content-Security-Policy string produced by
// next.config.mjs at HEAD *before* this file's fix (captured via
// `NODE_ENV=production node -e "import('./next.config.mjs')..."`, headers()
// with isDev=false and no NEXT_PUBLIC_API_URL override — i.e. the literal
// array `next.config.mjs` built inline, joined with "; "). Any change to
// this string for the production inputs below is a regression.
const PROD_CSP_ORACLE =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; " +
  "img-src 'self' data: blob: https:; " +
  "connect-src 'self' https: wss:; " +
  "frame-src 'self' blob: https:; " +
  "worker-src 'self' blob:; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

describe("buildContentSecurityPolicy", () => {
  it("matches the pinned production CSP byte-for-byte (prod is unchanged)", () => {
    const csp = buildContentSecurityPolicy({
      isDev: false,
      apiUrl: "https://routeflowapi-production.up.railway.app/api/v1",
    });
    expect(csp).toBe(PROD_CSP_ORACLE);
  });

  it("adds the http/ws localhost origin pair to connect-src when NEXT_PUBLIC_API_URL is http:", () => {
    const csp = buildContentSecurityPolicy({
      isDev: false,
      apiUrl: "http://localhost:3000/api/v1",
    });
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(
      "connect-src 'self' https: wss: http://localhost:3000 ws://localhost:3000",
    );
  });

  it("falls back to the pinned production CSP when apiUrl is unset or invalid", () => {
    expect(buildContentSecurityPolicy({ isDev: false, apiUrl: undefined })).toBe(PROD_CSP_ORACLE);
    expect(buildContentSecurityPolicy({ isDev: false, apiUrl: "" })).toBe(PROD_CSP_ORACLE);
    expect(buildContentSecurityPolicy({ isDev: false, apiUrl: "not-a-url" })).toBe(PROD_CSP_ORACLE);
  });

  it("still adds the next-dev wildcard localhost sources when isDev is true", () => {
    const csp = buildContentSecurityPolicy({ isDev: true, apiUrl: undefined });
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(connectSrc).toBe("connect-src 'self' https: wss: http://localhost:* ws://localhost:*");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });
});

describe("apiConnectSources", () => {
  it("returns an empty string for an https origin", () => {
    expect(apiConnectSources("https://routeflowapi-production.up.railway.app/api/v1")).toBe("");
  });

  it("returns a leading-space http/ws origin pair for an http origin", () => {
    expect(apiConnectSources("http://localhost:3000/api/v1")).toBe(
      " http://localhost:3000 ws://localhost:3000",
    );
  });

  it("returns an empty string for an unparseable or missing value", () => {
    expect(apiConnectSources(undefined)).toBe("");
    expect(apiConnectSources("")).toBe("");
    expect(apiConnectSources("not-a-url")).toBe("");
  });
});
