import {
  extraWebOrigins,
  isOnAllowedWebBase,
  normalizeOrigin,
  parseWebOrigins,
  pickFromOrigins,
  pickWebOrigin,
  webReturnBase,
} from "./web-origins";

/**
 * WP2A.0: the `WEB_ORIGINS` allow-list. Every helper takes an explicit env object so no spec mutates `process.env`.
 */
describe("web-origins — parseWebOrigins", () => {
  const SECOND = "https://www.acme-next.test";

  it("returns an empty list for unset or blank input", () => {
    expect(parseWebOrigins(undefined, "test")).toEqual([]);
    expect(parseWebOrigins("", "test")).toEqual([]);
    expect(parseWebOrigins("  ,  , ", "test")).toEqual([]);
  });

  it("trims, strips trailing slashes and skips blank entries", () => {
    expect(parseWebOrigins(` ${SECOND}/ , , https://b.acme-next.test// `, "test")).toEqual([
      SECOND,
      "https://b.acme-next.test",
    ]);
  });

  it("canonicalizes an entry with a default port and a path to the bare origin", () => {
    expect(parseWebOrigins("https://X.test:443/path", "test")).toEqual(["https://x.test"]);
  });

  it("keeps a non-default port", () => {
    expect(parseWebOrigins("https://x.test:8443", "test")).toEqual(["https://x.test:8443"]);
  });

  it("collapses duplicates (including ones that differ only in a trailing slash or default port)", () => {
    expect(parseWebOrigins(`${SECOND},${SECOND}/,https://www.acme-next.test:443`, "test")).toEqual([
      SECOND,
    ]);
  });

  it("drops a non-http(s) or unparseable entry outside production", () => {
    expect(parseWebOrigins(`javascript:alert(1),foo,${SECOND}`, "test")).toEqual([SECOND]);
    expect(parseWebOrigins("javascript:alert(1)", undefined)).toEqual([]);
  });

  it("THROWS on a non-http(s) or unparseable entry in production", () => {
    expect(() => parseWebOrigins("javascript:alert(1)", "production")).toThrow(/WEB_ORIGINS/);
    expect(() => parseWebOrigins("foo", "production")).toThrow(/WEB_ORIGINS/);
  });

  it("keeps a localhost / loopback entry outside production", () => {
    expect(parseWebOrigins("http://localhost:3001,http://127.0.0.1", "development")).toEqual([
      "http://localhost:3001",
      "http://127.0.0.1",
    ]);
  });

  it("THROWS on a localhost / loopback entry in production", () => {
    expect(() => parseWebOrigins("http://localhost:3001", "production")).toThrow(/loopback/);
    expect(() => parseWebOrigins("http://127.0.0.1", "production")).toThrow(/loopback/);
  });

  it("accepts a clean https entry in production", () => {
    expect(parseWebOrigins(SECOND, "production")).toEqual([SECOND]);
  });
});

describe("web-origins — extraWebOrigins / normalizeOrigin", () => {
  it("reads WEB_ORIGINS and NODE_ENV from the env object given", () => {
    expect(extraWebOrigins({ WEB_ORIGINS: "https://www.acme-next.test/" } as any)).toEqual([
      "https://www.acme-next.test",
    ]);
    expect(extraWebOrigins({} as any)).toEqual([]);
    expect(() => extraWebOrigins({ WEB_ORIGINS: "foo", NODE_ENV: "production" } as any)).toThrow();
  });

  it("normalizeOrigin canonicalizes through the URL parser and returns an unparseable value as-is", () => {
    expect(normalizeOrigin("https://Example.com:443/x")).toBe("https://example.com");
    expect(normalizeOrigin("not a url")).toBe("not a url");
  });
});

describe("web-origins — pickWebOrigin / pickFromOrigins (exact match only)", () => {
  const SECOND = "https://www.acme-next.test";
  const FALLBACK = "https://app.routeflow.test";
  const env = { WEB_ORIGINS: SECOND } as any;

  it("returns the candidate when it is exactly on the list", () => {
    expect(pickWebOrigin(SECOND, FALLBACK, env)).toBe(SECOND);
    expect(pickFromOrigins(SECOND, [SECOND], FALLBACK)).toBe(SECOND);
  });

  it.each([
    ["a look-alike host", `${SECOND}.evil.test`],
    ["a trailing slash", `${SECOND}/`],
    ["an uppercased origin", SECOND.toUpperCase()],
    ["an array (repeated header)", [SECOND]],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a number", 7],
  ])("falls back for %s", (_label, candidate) => {
    expect(pickWebOrigin(candidate, FALLBACK, env)).toBe(FALLBACK);
  });

  it("falls back for everything when the list is empty", () => {
    expect(pickWebOrigin(SECOND, FALLBACK, {} as any)).toBe(FALLBACK);
  });

  it("webReturnBase returns the request's own extra origin, else the web base", () => {
    const e = { WEB_URL: "https://app.routeflow.test", WEB_ORIGINS: SECOND } as any;
    expect(webReturnBase(SECOND, e)).toBe(SECOND);
    expect(webReturnBase(`${SECOND}.evil.test`, e)).toBe("https://app.routeflow.test");
    expect(webReturnBase(undefined, e)).toBe("https://app.routeflow.test");
    expect(webReturnBase(SECOND, { WEB_URL: "https://app.routeflow.test/" } as any)).toBe(
      "https://app.routeflow.test",
    );
  });
});

describe("web-origins — isOnAllowedWebBase", () => {
  const env = {
    WEB_URL: "https://app.routeflow.test",
    WEB_ORIGINS: "https://www.acme-next.test",
  } as any;

  it("accepts a URL on the second address", () => {
    expect(isOnAllowedWebBase("https://www.acme-next.test/settings/billing?x", env)).toBe(true);
    expect(isOnAllowedWebBase("https://www.acme-next.test", env)).toBe(true);
  });

  it("accepts a URL on the web base", () => {
    expect(isOnAllowedWebBase("https://app.routeflow.test/x", env)).toBe(true);
  });

  it("rejects a look-alike host and a longer host name", () => {
    expect(isOnAllowedWebBase("https://www.acme-next.test.evil.test/x", env)).toBe(false);
    expect(isOnAllowedWebBase("https://www.acme-next.testx/", env)).toBe(false);
  });

  it("with WEB_ORIGINS unset, the second address is off base (today's single base)", () => {
    const only = { WEB_URL: "https://app.routeflow.test" } as any;
    expect(isOnAllowedWebBase("https://www.acme-next.test/settings/billing", only)).toBe(false);
    expect(isOnAllowedWebBase("https://app.routeflow.test/settings/billing", only)).toBe(true);
  });
});
