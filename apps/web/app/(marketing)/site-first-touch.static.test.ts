/**
 * @jest-environment-options {"url": "http://localhost:3001/"}
 */
// The site keeps the first visit's source (sessionStorage key rf_first_touch, written once per tab, never overwritten).
// jsdom: the served js/first-touch.js text is loaded and run, once per case, against a fresh location and referrer.
// FT1-FT7 behaviour, FT8 static (no cookie, no network). FT9 is e2e spec 94.
import fs from "node:fs";
import path from "node:path";

const SITE = path.resolve(__dirname, "../../public/site");
const SRC = fs.readFileSync(path.join(SITE, "js/first-touch.js"), "utf8");
const KEY = "rf_first_touch";
/** The file is the block alone (SA-1184 K1); an empty or missing file is red for every case. */
function block(): string {
  if (!SRC.includes(KEY)) throw new Error("first-touch.js does not hold the first-touch block");
  return SRC;
}

/** Load the page at `url` with `referrer`, then run the served first-touch.js text. */
function view(url: string, referrer = ""): void {
  block(); // every case needs the block to exist, so a missing block is red for all of them
  window.history.pushState({}, "", url);
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

const stored = (): Record<string, string> | null => {
  const raw = window.sessionStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
};

beforeEach(() => {
  window.sessionStorage.clear();
  delete (window as unknown as { gsap?: unknown }).gsap;
});
afterEach(() => jest.restoreAllMocks());

describe("site first touch", () => {
  it("FT1 tags on /pricing with no referrer: exactly the tags, landingPath and firstSeenAt", () => {
    view("/pricing?utm_source=test&utm_medium=email");
    const rec = stored()!;
    expect(rec).not.toBeNull();
    const { firstSeenAt, ...rest } = rec;
    expect(rest).toEqual({ utm_source: "test", utm_medium: "email", landingPath: "/pricing" });
    expect(new Date(firstSeenAt).toISOString()).toBe(firstSeenAt);
  });

  it("FT2 an existing key is never overwritten by a second view with other tags", () => {
    view("/pricing?utm_source=test&utm_medium=email");
    const first = window.sessionStorage.getItem(KEY);
    expect(first).not.toBeNull();
    view("/?utm_source=other&gclid=abc", "https://news.example.org/a?b=1");
    expect(window.sessionStorage.getItem(KEY)).toBe(first);
  });

  it("FT3 a cross-site referrer with no tags: referrerHost is the hostname only, plus landingPath", () => {
    view("/product", "https://news.example.org:8443/some/path?q=1#h");
    const { firstSeenAt, ...rest } = stored()!;
    expect(firstSeenAt).toEqual(expect.any(String));
    expect(rest).toEqual({ referrerHost: "news.example.org", landingPath: "/product" });
  });

  it("FT4 a same-site referrer with no tags writes nothing", () => {
    view("/pricing", `${window.location.origin}/product`);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("FT4b a same-site referrer with tags keeps the tags and leaves referrerHost out", () => {
    view("/pricing?fbclid=zz", `${window.location.origin}/product`);
    const { firstSeenAt, ...rest } = stored()!;
    expect(firstSeenAt).toEqual(expect.any(String));
    expect(rest).toEqual({ fbclid: "zz", landingPath: "/pricing" });
  });

  it("FT4c a same-site referrer on a non-default port (localhost:3001) writes nothing", () => {
    expect(window.location.host).toBe("localhost:3001");
    view("/pricing", "http://localhost:3001/");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("FT4d a referrer on another port (localhost:3000) is cross-site: referrerHost is the hostname", () => {
    view("/pricing", "http://localhost:3000/");
    const { firstSeenAt, ...rest } = stored()!;
    expect(firstSeenAt).toEqual(expect.any(String));
    expect(rest).toEqual({ referrerHost: "localhost", landingPath: "/pricing" });
  });

  it("FT5 no tags and no referrer writes nothing", () => {
    view("/pricing?plan=pro");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("FT6 the query stays out of landingPath and empty values are left out", () => {
    view("/pricing?utm_term=&utm_campaign=spring&x=1&msclkid=m1");
    const { firstSeenAt, ...rest } = stored()!;
    expect(firstSeenAt).toEqual(expect.any(String));
    expect(rest).toEqual({ utm_campaign: "spring", msclkid: "m1", landingPath: "/pricing" });
    expect(rest.landingPath).not.toContain("?");
  });

  it("FT6b a page with only empty tags and no referrer writes nothing", () => {
    view("/pricing?utm_term=&utm_source=");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("FT7 sessionStorage.setItem throws: no error escapes", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => view("/pricing?utm_source=test")).not.toThrow();
  });

  it("K3 a non-http referrer (android-app, about) writes no referrerHost", () => {
    view("/pricing?utm_source=test", "android-app://com.example.mail/");
    expect(stored()).not.toHaveProperty("referrerHost");
    window.sessionStorage.clear();
    view("/pricing", "android-app://com.example.mail/");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    view("/pricing", "about:blank");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("FT8 the file holds no cookie, network or beacon call", () => {
    const b = block();
    for (const bad of ["document.cookie", "fetch(", "XMLHttpRequest", "sendBeacon"]) {
      expect(b).not.toContain(bad);
    }
    expect(b).toContain(KEY);
    expect(b).not.toContain("gsap");
  });
});
