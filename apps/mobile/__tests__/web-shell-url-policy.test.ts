/**
 * #2653 — the hybrid shell's navigation policy: only the web origin loads in-app, other web links
 * open in the system browser, and every non-http(s) scheme is refused.
 */
import { allowedOrigins, classifyNavigation, httpOrigin } from "../lib/web-shell/url-policy";

const WEB = "https://www.example-routeflow.test";
const ALLOWED = allowedOrigins(WEB);

describe("allowedOrigins", () => {
  it("is the web base URL's origin, normalised", () => {
    expect(allowedOrigins("https://WWW.Example-RouteFlow.test/some/path?x=1")).toEqual([
      "https://www.example-routeflow.test",
    ]);
  });

  it("accepts extra origins (e.g. the API) the same way", () => {
    expect(allowedOrigins(WEB, ["https://api.example-routeflow.test/api/v1"])).toEqual([
      "https://www.example-routeflow.test",
      "https://api.example-routeflow.test",
    ]);
  });

  it("drops an unparsable, non-http or plain-http non-local base (shell stays off)", () => {
    expect(allowedOrigins("")).toEqual([]);
    expect(allowedOrigins("not a url")).toEqual([]);
    expect(allowedOrigins("file:///etc")).toEqual([]);
    expect(allowedOrigins("http://www.example-routeflow.test")).toEqual([]);
  });

  it("tolerates http only for a local / private-LAN dev host", () => {
    for (const ok of [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://10.0.2.2:3001",
      "http://192.168.4.25:3001",
      "http://10.1.2.3",
      "http://172.20.0.5:3001",
    ]) {
      expect(allowedOrigins(ok)).toEqual([ok]);
    }
    for (const no of [
      "http://172.32.0.1:3001", // outside 172.16/12
      "http://8.8.8.8",
      "http://192.169.1.1",
      "http://evil.example",
      "http://192.168.1.1.evil.example",
    ]) {
      expect(allowedOrigins(no)).toEqual([]);
    }
  });
});

describe("classifyNavigation", () => {
  it.each([
    `${WEB}/`,
    `${WEB}/orders/123?tab=lines#top`,
    "https://WWW.example-routeflow.test/buyer/login",
  ])("loads the web origin in-app: %s", (url) => {
    expect(classifyNavigation(url, ALLOWED)).toBe("load");
  });

  it("loads the WebView's own about:blank", () => {
    expect(classifyNavigation("about:blank", ALLOWED)).toBe("load");
  });

  it.each([
    "https://maps.google.com/?q=1+Main+St",
    "https://www.example-routeflow.test.evil.example/phish",
    "https://example-routeflow.test/", // a different host is a different origin
    "http://www.example-routeflow.test/", // a scheme downgrade is a different origin
    "https://www.example-routeflow.test:8443/",
  ])("sends any other http(s) top-frame URL to the system browser: %s", (url) => {
    expect(classifyNavigation(url, ALLOWED)).toBe("external");
  });

  it.each([
    "file:///data/user/0/com.routeflow.mobile/files/secret",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "intent://scan/#Intent;scheme=zxing;end",
    "routeflow://anything",
    "tel:+15555550100",
    "mailto:someone@example.com",
    "not a url",
    "",
  ])("blocks every non-http(s) scheme: %s", (url) => {
    expect(classifyNavigation(url, ALLOWED)).toBe("block");
  });

  it("blocks a non-allowlisted iframe instead of bouncing it to the browser", () => {
    expect(classifyNavigation("https://ads.example/frame", ALLOWED, { isTopFrame: false })).toBe(
      "block",
    );
    expect(classifyNavigation(`${WEB}/embed`, ALLOWED, { isTopFrame: false })).toBe("load");
  });

  it("an empty allowlist (shell misconfigured) loads nothing in-app", () => {
    expect(classifyNavigation(`${WEB}/`, [])).toBe("external");
  });
});

describe("httpOrigin", () => {
  it("is null for non-http schemes and junk", () => {
    expect(httpOrigin("ftp://x.test/")).toBeNull();
    expect(httpOrigin("::")).toBeNull();
  });
});
