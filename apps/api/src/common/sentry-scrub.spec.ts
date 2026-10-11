import { redactUrl, scrubSentryEvent } from "./sentry-scrub";

// A live-shaped single-use token: 32 random bytes, base64url (43 chars).
const TOKEN = "q3Zr8wLk0Vb2nXy7TgHs1EaPd9UcJm4oRfWiKtNxA5s";

describe("scrubSentryEvent", () => {
  it("rewrites the request URL to the redacted route and drops query, body, cookies and credentials", () => {
    const event = {
      message: "boom",
      request: {
        method: "POST",
        url: `https://api.example.test/api/v1/buyer/invites/${TOKEN}/accept?token=${TOKEN}&x=1#f`,
        query_string: `token=${TOKEN}`,
        data: JSON.stringify({ token: TOKEN, password: "pw" }),
        cookies: { session: TOKEN },
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          cookie: `sid=${TOKEN}`,
          "x-api-key": TOKEN,
          "user-agent": "jest",
        },
      },
    };

    const out = scrubSentryEvent(event);

    expect(out).toBe(event);
    expect(out.request.url).toBe("https://api.example.test/api/v1/buyer/invites/:redacted/accept");
    expect(out.request).not.toHaveProperty("query_string");
    expect(out.request).not.toHaveProperty("data");
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request.headers).toEqual({ "user-agent": "jest" });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("redacts a token in the path even without a secret-bearing segment name", () => {
    expect(redactUrl(`https://h.test/api/v1/x/${TOKEN}`)).toBe("https://h.test/api/v1/x/:redacted");
    expect(redactUrl(`/api/v1/x/${TOKEN}?a=1`)).toBe("/api/v1/x/:redacted");
  });

  it("leaves ordinary routes and ids alone", () => {
    const id = "0b8e6f0c-5f0e-4f4e-9d52-3b2a9f1c7a10";
    expect(redactUrl(`https://h.test/api/v1/orders/${id}`)).toBe(
      `https://h.test/api/v1/orders/${id}`,
    );
  });

  it("redacts a token in a transaction name, its spans and trace data", () => {
    const event = {
      transaction: `GET /api/v1/buyer/auth/verify-merge/${TOKEN}?x=1`,
      contexts: {
        trace: {
          data: { "url.full": `https://h.test/a/${TOKEN}?q=1`, "url.query": `q=${TOKEN}`, keep: 1 },
        },
      },
      spans: [
        {
          description: `GET /api/v1/reset/${TOKEN}`,
          data: { "http.url": `https://h.test/r/${TOKEN}`, "http.query": `t=${TOKEN}` },
        },
      ],
    };

    scrubSentryEvent(event);

    expect(event.transaction).toBe("GET /api/v1/buyer/auth/verify-merge/:redacted");
    expect(event.contexts.trace.data).toEqual({
      "url.full": "https://h.test/a/:redacted",
      keep: 1,
    });
    expect(event.spans[0].description).toBe("GET /api/v1/reset/:redacted");
    expect(event.spans[0].data).toEqual({ "http.url": "https://h.test/r/:redacted" });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("passes an event with no request through and never throws on odd shapes", () => {
    expect(scrubSentryEvent({ message: "m" })).toEqual({ message: "m" });
    expect(() =>
      scrubSentryEvent({ request: { url: 5, headers: null }, spans: [null, 3] }),
    ).not.toThrow();
  });
});
