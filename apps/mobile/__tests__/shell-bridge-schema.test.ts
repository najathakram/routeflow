/**
 * #2653 / SA-542 — the shell bridge's envelope schema (packages/ui/src/shell-bridge.ts). Mobile's
 * Jest resolves "@routeflow/ui/shell-bridge" to that source (jest.config.js), ahead of the ui stub.
 */
import {
  SHELL_BRIDGE_MAX_BYTES,
  isShellUserAgent,
  shellUserAgentToken,
  encodeNativeToWeb,
  parseNativeToWeb,
  parseWebToNative,
} from "@routeflow/ui/shell-bridge";

const msg = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseWebToNative — what the page may ask for", () => {
  it.each(["shell.hello", "scan.request", "push.register", "auth.logout", "auth.handoff"])(
    "accepts a well-formed %s",
    (type) => {
      expect(parseWebToNative(msg({ v: 1, id: "r1", type, payload: {} }))).toEqual({
        v: 1,
        id: "r1",
        type,
        payload: {},
      });
    },
  );

  it.each([
    ["an unknown type", { v: 1, id: "r1", type: "link.open", payload: {} }],
    ["navigate", { v: 1, id: "r1", type: "navigate", payload: {} }],
    ["a wrong version", { v: 2, id: "r1", type: "shell.hello", payload: {} }],
    ["a missing id", { v: 1, type: "shell.hello", payload: {} }],
    ["an oversized id", { v: 1, id: "x".repeat(65), type: "shell.hello", payload: {} }],
    ["a token in the payload", { v: 1, id: "r1", type: "auth.logout", payload: { token: "eyJ" } }],
    ["a code in the payload", { v: 1, id: "r1", type: "auth.handoff", payload: { code: "abc" } }],
    ["an extra envelope field", { v: 1, id: "r1", type: "shell.hello", payload: {}, url: "x" }],
    [
      "a native→web type",
      { v: 1, id: "r1", type: "scan.result", payload: { replyTo: "r0", code: "1" } },
    ],
  ])("drops %s", (_l, o) => {
    expect(parseWebToNative(msg(o))).toBeNull();
  });

  it.each([
    ["not a string", { v: 1 }],
    ["empty", ""],
    ["not JSON", "{nope"],
    [
      "over the size cap",
      msg({
        v: 1,
        id: "r1",
        type: "shell.hello",
        payload: {},
        pad: "x".repeat(SHELL_BRIDGE_MAX_BYTES),
      }),
    ],
  ])("drops raw input that is %s", (_l, raw) => {
    expect(parseWebToNative(raw)).toBeNull();
  });
});

describe("parseNativeToWeb / encodeNativeToWeb — the shell's answers", () => {
  it("round-trips shell.ready with capabilities", () => {
    const out = encodeNativeToWeb({
      v: 1,
      id: "n1",
      type: "shell.ready",
      payload: { replyTo: "r1", capabilities: { scan: true, push: false, handoff: false } },
    });
    expect(parseNativeToWeb(out)?.type).toBe("shell.ready");
  });

  it("carries a scanned code, capped at 256 chars", () => {
    const ok = msg({
      v: 1,
      id: "n2",
      type: "scan.result",
      payload: { replyTo: "r2", code: "012345" },
    });
    expect(parseNativeToWeb(ok)).not.toBeNull();
    const long = msg({
      v: 1,
      id: "n2",
      type: "scan.result",
      payload: { replyTo: "r2", code: "9".repeat(257) },
    });
    expect(parseNativeToWeb(long)).toBeNull();
  });

  it("refuses to encode a message carrying an extra field (a programming error, loud)", () => {
    expect(() =>
      encodeNativeToWeb({
        v: 1,
        id: "n3",
        type: "push.result",
        payload: { replyTo: "r3", registered: true, token: "ExponentPushToken[x]" },
      } as never),
    ).toThrow();
  });
});

describe("the shell user-agent marker (SA-542a)", () => {
  const SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

  it("mints RouteFlowShell/<version>, sanitising a junk version", () => {
    expect(shellUserAgentToken("1.4.2")).toBe("RouteFlowShell/1.4.2");
    expect(shellUserAgentToken("1 2; <x>")).toBe("RouteFlowShell/0");
  });

  it("detects the token wherever the WebView appends it", () => {
    expect(isShellUserAgent(`${SAFARI} ${shellUserAgentToken("1.4.2")}`)).toBe(true);
    expect(isShellUserAgent(shellUserAgentToken("0"))).toBe(true);
  });

  it.each([
    ["a plain browser", SAFARI],
    ["a look-alike product", `${SAFARI} RouteFlowShellX/1`],
    ["a bare product with no version", `${SAFARI} RouteFlowShell`],
    ["empty", ""],
    ["null", null],
  ])("is false for %s", (_l, ua) => {
    expect(isShellUserAgent(ua as string | null)).toBe(false);
  });
});
