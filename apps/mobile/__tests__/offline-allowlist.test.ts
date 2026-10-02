import {
  ONLINE_REQUIRED_MESSAGE,
  OFFLINE_SAFE_ENDPOINTS,
  countLegacyNonAllowlisted,
  isOfflineSafe,
} from "../lib/offline-allowlist";

/**
 * B923: ONLY an explicit allow-list of offline-safe endpoints may enter the offline queue. Everything
 * else is online-only. These are the 7 offline-designed flows (idempotency header or queue-aware
 * callers): order create, return create, inline-return capture, the driver's stop status / completion /
 * POD attach, and the at-door change request + its resolve.
 */
describe("isOfflineSafe (B923)", () => {
  const ALLOWED: Array<[string, string]> = [
    ["POST", "/orders"],
    ["POST", "/returns"],
    ["POST", "/returns/inline/capture"],
    ["PATCH", "/route-runs/run-1/stops/stop-1"],
    ["POST", "/route-runs/run-1/stops/stop-1/complete-with-payment"],
    ["POST", "/route-runs/run-1/stops/stop-1/pod-artifact"],
    ["POST", "/orders/ord-1/change-requests/cr-1/resolve"],
  ];

  it.each(ALLOWED)(
    "%s %s is offline-safe (also with a query string and lower-case method)",
    (m, u) => {
      expect(isOfflineSafe(m, u)).toBe(true);
      expect(isOfflineSafe(m.toLowerCase(), `${u}?x=1`)).toBe(true);
    },
  );

  it("the allow-list has exactly the 7 approved entries", () => {
    expect(OFFLINE_SAFE_ENDPOINTS).toHaveLength(7);
  });

  it("POST /orders/:id/change-requests is online-only (no server dedupe yet, B936): replay could double-create", () => {
    expect(isOfflineSafe("POST", "/orders/ord-1/change-requests")).toBe(false);
    expect(
      OFFLINE_SAFE_ENDPOINTS.some((e) => e.pattern.test("/orders/ord-1/change-requests")),
    ).toBe(false);
  });

  const BLOCKED: Array<[string, string]> = [
    ["PATCH", "/orders/ord-1/status"],
    ["PATCH", "/orders/ord-1/items"],
    ["POST", "/orders/sell"],
    ["DELETE", "/orders/ord-1"],
    ["POST", "/orders/ord-1/reopen"],
    ["POST", "/returns/ret-1/receive"],
    ["POST", "/returns/ret-1/refund"],
    ["POST", "/route-runs/run-1/stops/stop-1/reopen"],
    ["PATCH", "/route-runs/run-1/status"],
    ["POST", "/invoices/inv-1/payments"],
    ["POST", "/invoices/payments/record"],
    ["POST", "/drafts"],
    ["PATCH", "/drafts/d-1"],
    ["DELETE", "/drafts/d-1"],
    ["POST", "/drivers/me/location"],
    ["POST", "/auth/login"],
    ["POST", "/auth/refresh"],
    ["POST", "/notifications/register-token"],
    ["PATCH", "/users/me/preferences"],
    ["POST", "/auth/change-password"],
    ["POST", "/customers"],
    ["PUT", "/inventory/stock-counts/sc-1/lines"],
  ];

  it.each(BLOCKED)("%s %s is online-only", (m, u) => {
    expect(isOfflineSafe(m, u)).toBe(false);
  });

  it("is method-sensitive and anchored (a sibling or longer path never matches)", () => {
    expect(isOfflineSafe("GET", "/orders")).toBe(false);
    expect(isOfflineSafe("DELETE", "/orders")).toBe(false);
    expect(isOfflineSafe("PATCH", "/orders")).toBe(false);
    expect(isOfflineSafe("POST", "/orders/extra")).toBe(false);
    expect(isOfflineSafe("POST", "/x/orders")).toBe(false);
    expect(isOfflineSafe("POST", "/returns/inline/capture/x")).toBe(false);
    expect(isOfflineSafe("PATCH", "/route-runs/run-1/stops/stop-1/extra")).toBe(false);
  });

  it("every entry states why it is offline-safe and how a replay stays safe (no entry without a replay story)", () => {
    for (const e of OFFLINE_SAFE_ENDPOINTS) {
      expect(e.reason.length).toBeGreaterThan(20);
      expect(["idempotency-key", "idempotent-by-contract"]).toContain(e.replaySafety);
      expect(e.replayNote.length).toBeGreaterThan(20);
    }
  });
});

describe("ONLINE_REQUIRED_MESSAGE", () => {
  it("is the fixed, plain sentence the screens show", () => {
    expect(ONLINE_REQUIRED_MESSAGE).toBe("You're offline. Connect and try again.");
  });
});

describe("countLegacyNonAllowlisted (one-time telemetry, B923 ruling 5)", () => {
  const act = (method: string, endpoint: string) => ({ method, endpoint }) as never;

  it("counts only the persisted entries that the allow-list no longer admits, grouped by method + pattern", () => {
    const res = countLegacyNonAllowlisted([
      act("POST", "/orders"),
      act("PATCH", "/orders/ord-1/status"),
      act("PATCH", "/orders/ord-2/status"),
      act("POST", "/customers/c-1/comments"),
    ]);
    expect(res.total).toBe(3);
    expect(res.byEndpoint).toEqual({
      "PATCH /orders/:id/status": 2,
      "POST /customers/:id/comments": 1,
    });
  });

  it("is zero for an all-allow-listed queue and never includes an id or body", () => {
    const res = countLegacyNonAllowlisted([act("POST", "/returns"), act("POST", "/orders")]);
    expect(res).toEqual({ total: 0, byEndpoint: {} });
    expect(
      JSON.stringify(countLegacyNonAllowlisted([act("PATCH", "/orders/ord-SECRET/status")])),
    ).not.toContain("SECRET");
  });
});
