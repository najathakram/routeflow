import { redactKeyPath, redactSentryEvent } from "./sentry-redact";

/**
 * SA-824 (Opus review SHOULD 3): with a DSN set, a Sentry event's request url, query string, transaction name and
 * headers must never carry a payment Idempotency-Key. The hook is a pure function: fabricated events, no DSN.
 */
describe("redactSentryEvent (beforeSend / beforeSendTransaction)", () => {
  it("redacts the key in request.url and transaction, drops query_string, for by-key and by-key/resolve", () => {
    const e = redactSentryEvent({
      transaction: "POST /api/v1/invoices/payments/by-key/RAW-KEY-1/resolve",
      request: {
        url: "https://api.example.test/api/v1/invoices/payments/by-key/RAW-KEY-1/resolve?k=RAW-KEY-1",
        query_string: "k=RAW-KEY-1",
        method: "POST",
      },
    });
    expect(e.transaction).toBe("POST /api/v1/invoices/payments/by-key/:key/resolve");
    expect(e.request?.url).toBe(
      "https://api.example.test/api/v1/invoices/payments/by-key/:key/resolve",
    );
    expect(e.request?.query_string).toBeUndefined();
    expect(e.request?.method).toBe("POST");
    expect(JSON.stringify(e)).not.toContain("RAW-KEY-1");
  });

  it("is case-insensitive on the route, like Express routing", () => {
    const e = redactSentryEvent({
      transaction: "GET /api/v1/INVOICES/payments/By-Key/RAW-KEY-2",
      request: { url: "/api/v1/INVOICES/payments/BY-KEY/RAW-KEY-2?x=1", query_string: "x=1" },
    });
    expect(JSON.stringify(e)).not.toContain("RAW-KEY-2");
    expect(e.request?.query_string).toBeUndefined();
  });

  it("redacts an Idempotency-Key request header on any path", () => {
    const e = redactSentryEvent({
      request: {
        url: "/api/v1/invoices/payments/record",
        headers: { "Idempotency-Key": "RAW-KEY-3", accept: "x" },
      },
    });
    expect(JSON.stringify(e)).not.toContain("RAW-KEY-3");
    expect(e.request?.headers?.accept).toBe("x");
  });

  it("leaves every other event untouched (query_string included) and tolerates a bare event", () => {
    const other = {
      transaction: "GET /api/v1/orders",
      request: { url: "/api/v1/orders?page=2", query_string: "page=2" },
    };
    expect(redactSentryEvent(structuredClone(other))).toEqual(other);
    expect(redactSentryEvent({})).toEqual({});
  });

  it("redactKeyPath is case-insensitive", () => {
    expect(redactKeyPath("/api/v1/invoices/payments/BY-KEY/K9/resolve")).toBe(
      "/api/v1/invoices/payments/BY-KEY/:key/resolve",
    );
  });
});
