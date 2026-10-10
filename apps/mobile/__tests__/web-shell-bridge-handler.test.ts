/**
 * #2653 / SA-542 — the native bridge decision: origin first (nativeEvent.url vs the allowlist),
 * then the schema; each allowed request maps to exactly one action.

 */

import { handleBridgeMessage, type BridgeContext } from "../lib/web-shell/bridge-handler";

const WEB = "https://www.example-routeflow.test";
const ctx = (o: Partial<BridgeContext> = {}): BridgeContext => {
  let n = 0;
  return {
    allowed: [WEB],
    hasStaffSession: true,
    scanAvailable: true,
    newId: () => `n${++n}`,
    ...o,
  };
};
const raw = (type: string, payload: Record<string, unknown> = {}, id = "r1") =>
  JSON.stringify({ v: 1, id, type, payload });

describe("origin check comes first", () => {
  it.each([
    ["a foreign page", "https://evil.example/x"],
    ["a look-alike host", "https://www.example-routeflow.test.evil.example/"],
    ["a non-http page", "file:///x"],
    ["no url", undefined],
  ])("drops a perfectly valid message from %s", (_l, url) => {
    expect(handleBridgeMessage(raw("shell.hello"), url, ctx())).toEqual({ kind: "drop" });
  });

  it("drops a malformed message even from the web origin", () => {
    expect(handleBridgeMessage("{bad", `${WEB}/orders`, ctx())).toEqual({ kind: "drop" });
    expect(handleBridgeMessage(raw("link.open", { url: "https://x" }), `${WEB}/`, ctx())).toEqual({
      kind: "drop",
    });
  });
});

describe("shell.hello → shell.ready with capabilities", () => {
  it("advertises scan + push for a staff session, handoff off", () => {
    expect(handleBridgeMessage(raw("shell.hello", {}, "h1"), `${WEB}/`, ctx())).toEqual({
      kind: "reply",
      message: {
        v: 1,
        id: "n1",
        type: "shell.ready",
        payload: { replyTo: "h1", capabilities: { scan: true, push: true, handoff: false } },
      },
    });
  });

  it("advertises no push without a native staff session (fallback buyer)", () => {
    const a = handleBridgeMessage(
      raw("shell.hello"),
      `${WEB}/buyer/login`,
      ctx({ hasStaffSession: false }),
    );
    expect(
      a.kind === "reply" && a.message.type === "shell.ready" && a.message.payload.capabilities.push,
    ).toBe(false);
  });
});

describe("requests", () => {
  it("scan.request opens the scanner, or answers scan.cancelled when no camera", () => {
    expect(handleBridgeMessage(raw("scan.request", {}, "s1"), `${WEB}/shop`, ctx())).toEqual({
      kind: "scan",
      replyTo: "s1",
    });
    const none = handleBridgeMessage(
      raw("scan.request", {}, "s1"),
      `${WEB}/shop`,
      ctx({ scanAvailable: false }),
    );
    expect(none).toEqual({
      kind: "reply",
      message: { v: 1, id: "n1", type: "scan.cancelled", payload: { replyTo: "s1" } },
    });
  });

  it("push.register registers with the app's own JWT, or answers registered:false without one", () => {
    expect(handleBridgeMessage(raw("push.register", {}, "p1"), `${WEB}/`, ctx())).toEqual({
      kind: "push",
      replyTo: "p1",
    });
    expect(
      handleBridgeMessage(
        raw("push.register", {}, "p1"),
        `${WEB}/`,
        ctx({ hasStaffSession: false }),
      ),
    ).toEqual({
      kind: "reply",
      message: {
        v: 1,
        id: "n1",
        type: "push.result",
        payload: { replyTo: "p1", registered: false },
      },
    });
  });

  it("auth.logout signs the native session out", () => {
    expect(handleBridgeMessage(raw("auth.logout"), `${WEB}/`, ctx())).toEqual({ kind: "logout" });
  });

  it("auth.handoff is reserved (dropped) until the handoff ships", () => {
    expect(handleBridgeMessage(raw("auth.handoff"), `${WEB}/`, ctx())).toEqual({ kind: "drop" });
  });

  it("a token smuggled into any request is dropped by the strict schema", () => {
    expect(handleBridgeMessage(raw("auth.logout", { token: "eyJ" }), `${WEB}/`, ctx())).toEqual({
      kind: "drop",
    });
  });
});
