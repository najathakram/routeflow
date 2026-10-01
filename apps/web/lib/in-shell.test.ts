/**
 * @jest-environment jsdom
 *
 * #2653 / SA-542a — the pre-paint shell mark. SHELL_MARK_SCRIPT is executed for real in jsdom
 * with the WebView's UA shape and with a plain browser UA.
 */
import { SHELL_ATTR, SHELL_MARK_SCRIPT, isInShell } from "./in-shell";

const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function runWithUserAgent(ua: string) {
  document.documentElement.removeAttribute(SHELL_ATTR);
  const spy = jest.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
  try {
    // Executes the exact inline script the layout ships.
    new Function(SHELL_MARK_SCRIPT)();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => document.documentElement.removeAttribute(SHELL_ATTR));

describe("SHELL_MARK_SCRIPT", () => {
  it("marks <html data-shell=1> for the app shell's UA", () => {
    runWithUserAgent(`${SAFARI} RouteFlowShell/1.4.2`);
    expect(document.documentElement.getAttribute(SHELL_ATTR)).toBe("1");
    expect(isInShell()).toBe(true);
  });

  it.each([
    ["a plain browser", SAFARI],
    ["a look-alike product token", `${SAFARI} RouteFlowShellX/1`],
    ["the product with no version", `${SAFARI} RouteFlowShell`],
  ])("leaves %s unmarked", (_l, ua) => {
    runWithUserAgent(ua);
    expect(document.documentElement.hasAttribute(SHELL_ATTR)).toBe(false);
    expect(isInShell()).toBe(false);
  });

  it("is self-contained (no imports, no page data) and never throws", () => {
    expect(SHELL_MARK_SCRIPT).not.toMatch(/\bimport\b|\brequire\(/);
    const spy = jest.spyOn(window.navigator, "userAgent", "get").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      expect(() => new Function(SHELL_MARK_SCRIPT)()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
