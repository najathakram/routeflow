import { readFileSync } from "fs";
import { join } from "path";
import {
  LEGACY_QUERY_TTL_MS,
  LINK_FORMAT_CUTOVER_AT_MS,
  applyNoReferrerMeta,
  legacyQueryTokenAccepted,
  resolveLinkToken,
  scrubLinkTokenFromUrl,
  tokenFromFragment,
} from "../lib/link-token";

const T = "a".repeat(64);
const inWindow = LINK_FORMAT_CUTOVER_AT_MS - 1;
const edge = LINK_FORMAT_CUTOVER_AT_MS + LEGACY_QUERY_TTL_MS;

describe("tokenFromFragment", () => {
  it("reads t from the fragment, with or without the leading #", () => {
    expect(tokenFromFragment(`#t=${T}`)).toBe(T);
    expect(tokenFromFragment(`t=${T}`)).toBe(T);
  });
  it("is empty when absent, empty or absurdly long", () => {
    expect(tokenFromFragment(undefined)).toBe("");
    expect(tokenFromFragment("")).toBe("");
    expect(tokenFromFragment("#x=1")).toBe("");
    expect(tokenFromFragment("#t=")).toBe("");
    expect(tokenFromFragment(`#t=${"b".repeat(513)}`)).toBe("");
  });
});

describe("resolveLinkToken — the Expo reset page reads the fragment", () => {
  it("web: the router's '#' param is the fragment", () => {
    expect(resolveLinkToken({ platform: "web", fragmentParam: `t=${T}`, now: inWindow })).toBe(T);
  });
  it("web: falls back to window.location.hash when the router did not keep it", () => {
    expect(resolveLinkToken({ platform: "web", locationHash: `#t=${T}`, now: inWindow })).toBe(T);
  });
  it("web: the fragment wins over a legacy ?token=", () => {
    expect(
      resolveLinkToken({
        platform: "web",
        fragmentParam: `t=${T}`,
        queryToken: "legacy",
        now: inWindow,
      }),
    ).toBe(T);
  });
  it("web: reads the legacy ?token= only inside the legacy window", () => {
    expect(resolveLinkToken({ platform: "web", queryToken: "legacy", now: inWindow })).toBe(
      "legacy",
    );
    expect(resolveLinkToken({ platform: "web", queryToken: "legacy", now: edge - 1 })).toBe(
      "legacy",
    );
    expect(resolveLinkToken({ platform: "web", queryToken: "legacy", now: edge })).toBe("");
    expect(legacyQueryTokenAccepted(edge)).toBe(false);
  });
  it("web: the fragment still works after the legacy window closed", () => {
    expect(resolveLinkToken({ platform: "web", fragmentParam: `t=${T}`, now: edge + 1 })).toBe(T);
  });
  it("native: a deep link keeps handing the token over as the route param, at any time", () => {
    expect(resolveLinkToken({ platform: "native", queryToken: T, now: edge + 1e9 })).toBe(T);
    // native never reads window.location
    expect(resolveLinkToken({ platform: "native", locationHash: `#t=${T}` })).toBe("");
  });
  it("is empty with no token anywhere", () => {
    expect(resolveLinkToken({ platform: "web", now: inWindow })).toBe("");
    expect(resolveLinkToken({ platform: "native" })).toBe("");
  });
  it("the legacy window is the longest legacy lifetime: 72h", () => {
    expect(LEGACY_QUERY_TTL_MS).toBe(72 * 3_600_000);
  });
});

describe("scrubLinkTokenFromUrl", () => {
  function fakeWin(pathname: string, search: string, hash: string) {
    const replaceState = jest.fn();
    return {
      win: { location: { pathname, search, hash }, history: { replaceState } },
      replaceState,
    };
  }
  it("drops the fragment", () => {
    const { win, replaceState } = fakeWin("/reset-password", "", `#t=${T}`);
    scrubLinkTokenFromUrl(win);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
  });
  it("drops a legacy ?token= but keeps other params", () => {
    const { win, replaceState } = fakeWin("/reset-password", "?token=x&audience=buyer", "");
    scrubLinkTokenFromUrl(win);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password?audience=buyer");
  });
  it("does nothing when there is nothing to scrub", () => {
    const { win, replaceState } = fakeWin("/reset-password", "", "");
    scrubLinkTokenFromUrl(win);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("applyNoReferrerMeta", () => {
  function fakeDoc(existing?: { content: string }) {
    const appended: Array<{ name: string; content: string; parentNode?: unknown }> = [];
    const doc = {
      head: {
        appendChild: jest.fn((n: { name: string; content: string; parentNode?: unknown }) => {
          n.parentNode = { removeChild: jest.fn(() => appended.splice(appended.indexOf(n), 1)) };
          appended.push(n);
        }),
      },
      querySelector: jest.fn(() => (existing as never) ?? null),
      createElement: jest.fn(() => ({ name: "", content: "" })),
    };
    return { doc, appended };
  }
  it("adds <meta name=referrer content=no-referrer> and removes it on cleanup", () => {
    const { doc, appended } = fakeDoc();
    const cleanup = applyNoReferrerMeta(doc as never);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ name: "referrer", content: "no-referrer" });
    cleanup();
    expect(appended).toHaveLength(0);
  });
  it("overrides an existing referrer meta and restores it on cleanup", () => {
    const existing = { content: "origin" };
    const { doc } = fakeDoc(existing);
    const cleanup = applyNoReferrerMeta(doc as never);
    expect(existing.content).toBe("no-referrer");
    cleanup();
    expect(existing.content).toBe("origin");
  });
});

describe("reset-password.tsx wiring (RN screens are source-pinned in this lane)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(auth)/reset-password.tsx"), "utf8");

  it("resolves the token through the fragment-aware helper, not the bare route param", () => {
    expect(src).toMatch(/resolveLinkToken\(/);
    expect(src).toMatch(/params\["#"\]/);
    expect(src).not.toMatch(/const \{ token,/);
  });
  it("POSTs the token in the body and never puts it in the URL", () => {
    expect(src).toMatch(
      /axios\.post\(`\$\{BASE_URL\}\/api\/v1\$\{resetPasswordEndpoint\(audience\)\}`, \{\s*token,/,
    );
    expect(src).not.toMatch(/\?token=\$\{|\/\$\{token\}|\$\{token\}`/);
  });
  it("scrubs the address bar, clears the router params and sets the no-referrer meta on web", () => {
    expect(src).toMatch(/scrubLinkTokenFromUrl\(window\)/);
    expect(src).toMatch(/router\.setParams\(\{ "#": undefined, token: undefined \}/);
    expect(src).toMatch(/applyNoReferrerMeta\(/);
  });
  it("shows fixed failure copy, never the server's message, and never logs the token", () => {
    expect(src).not.toMatch(/response\??\.data/);
    expect(src).not.toMatch(/console\.\w+\([^)]*token/i);
  });
});
