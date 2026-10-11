import { redactPath, redactedRoute, REDACTED_SEGMENT } from "./redacted-route";

// Synthetic, token-shaped values (43 base64url chars / 64 hex chars); not real secrets.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const UUID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

describe("redactedRoute — METHOD /template", () => {
  it("uses the route template with the global prefix removed, never the raw URL", () => {
    const out = redactedRoute({
      method: "post",
      route: { path: "/api/v1/buyer/invites/:token/accept" },
      originalUrl: `/api/v1/buyer/invites/${TOKEN}/accept?t=${TOKEN}`,
    });
    expect(out).toBe("POST /buyer/invites/:token/accept");
    expect(out).not.toContain(TOKEN);
  });

  it("keeps an ordinary id out of the line too: it is the template, not the value", () => {
    expect(
      redactedRoute({
        method: "PATCH",
        route: { path: "/api/v1/orders/:id" },
        url: `/api/v1/orders/${UUID}`,
      }),
    ).toBe("PATCH /orders/:id");
  });

  it("falls back to the raw path, token segments redacted, when no template exists", () => {
    const out = redactedRoute({
      method: "POST",
      originalUrl: `/api/v1/anything/${TOKEN}/go?x=${TOKEN}`,
    });
    expect(out).toBe(`POST /api/v1/anything/${REDACTED_SEGMENT}/go`);
  });

  it("never emits the query string, with or without a template", () => {
    expect(redactedRoute({ method: "GET", url: "/api/v1/orders?secret=1" })).toBe(
      "GET /api/v1/orders",
    );
    expect(
      redactedRoute({ method: "GET", route: { path: "/orders" }, url: "/orders?secret=1" }),
    ).toBe("GET /orders");
  });

  it("tolerates a request with nothing on it", () => {
    expect(redactedRoute({})).toBe("? ?");
  });
});

describe("redactPath — token-shaped segments", () => {
  it("redacts a 20+ char base64url run and a hex run", () => {
    expect(redactPath(`/a/${TOKEN}`)).toBe(`/a/${REDACTED_SEGMENT}`);
    expect(redactPath(`/a/${HEX}/b`)).toBe(`/a/${REDACTED_SEGMENT}/b`);
  });

  it("redacts the segment after token / invites / verify / confirm / reset, however short", () => {
    for (const name of ["token", "tokens", "invites", "verify", "confirm", "reset"]) {
      expect(redactPath(`/api/v1/x/${name}/abc123`)).toBe(`/api/v1/x/${name}/${REDACTED_SEGMENT}`);
    }
    expect(redactPath("/x/Reset-Password/abc")).toBe(`/x/Reset-Password/${REDACTED_SEGMENT}`);
  });

  it("keeps uuids, short ids and literal route names intact", () => {
    expect(redactPath(`/api/v1/orders/${UUID}/items/42`)).toBe(`/api/v1/orders/${UUID}/items/42`);
    expect(redactPath("/api/v1/vendor-bills/scan-invoice")).toBe(
      "/api/v1/vendor-bills/scan-invoice",
    );
    expect(redactPath("/api/v1/billing/bulk-update-product-status")).toBe(
      "/api/v1/billing/bulk-update-product-status",
    );
  });

  it("keeps a uuid even directly after a secret-bearing name", () => {
    expect(redactPath(`/api/v1/invites/${UUID}`)).toBe(`/api/v1/invites/${UUID}`);
  });

  it("drops the query string and fragment", () => {
    expect(redactPath(`/a/b?t=${TOKEN}#t=${TOKEN}`)).toBe("/a/b");
  });
});
